const POLL_MS = 3000;
const TEAM_REFRESH_MS = 5000;

const elements = {
  refreshNote: document.getElementById('refresh-note'),
  refreshNow: document.getElementById('refresh-now'),
  autoRefresh: document.getElementById('auto-refresh'),
  kpiActiveJobs: document.getElementById('kpi-active-jobs'),
  kpiRunningTasks: document.getElementById('kpi-running-tasks'),
  kpiWaitingApproval: document.getElementById('kpi-waiting-approval'),
  kpiTotalTokens: document.getElementById('kpi-total-tokens'),
  jobsSummary: document.getElementById('jobs-summary'),
  activeJobsBody: document.getElementById('active-jobs-body'),
  activeAgentsBody: document.getElementById('active-agents-body'),
  tokensInput: document.getElementById('tokens-input'),
  tokensOutput: document.getElementById('tokens-output'),
  tokensTotal: document.getElementById('tokens-total'),
  tokensWith: document.getElementById('tokens-with'),
  tokensWithout: document.getElementById('tokens-without'),
  selectedJobLabel: document.getElementById('selected-job-label'),
  teamStateView: document.getElementById('team-state-view'),
  eventsList: document.getElementById('events-list'),
};

const state = {
  selectedJobId: null,
  overview: null,
  teamSnapshot: null,
  events: [],
  eventIds: new Set(),
  eventSource: null,
};

function formatNumber(value) {
  if (value == null || Number.isNaN(Number(value))) return 'N/A';
  return Number(value).toLocaleString();
}

function formatAgo(iso) {
  if (!iso) return 'N/A';
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms)) return 'N/A';
  if (ms < 1000) return 'just now';
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s ago`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`;
  return `${Math.floor(ms / 86_400_000)}d ago`;
}

function formatTime(iso) {
  if (!iso) return 'N/A';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return 'N/A';
  return date.toLocaleString();
}

function statusPill(status) {
  return `<span class="status-pill ${status || ''}">${status || 'unknown'}</span>`;
}

async function readJson(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Request failed: ${response.status}`);
  }
  return response.json();
}

function setRefreshNote(message) {
  elements.refreshNote.textContent = message;
}

function renderOverview() {
  const overview = state.overview;
  if (!overview) return;

  elements.kpiActiveJobs.textContent = formatNumber(overview.jobs.active);
  elements.kpiWaitingApproval.textContent = formatNumber(overview.jobs.waiting_approval);
  elements.kpiTotalTokens.textContent = formatNumber(overview.tokens.totalTokens);
  elements.jobsSummary.textContent = `Total jobs: ${formatNumber(overview.jobs.total)} · Running: ${formatNumber(overview.jobs.running)}`;

  const runningTasks = (overview.activeAgents || []).filter((agent) => agent.status === 'running').length;
  elements.kpiRunningTasks.textContent = formatNumber(runningTasks);

  elements.tokensInput.textContent = formatNumber(overview.tokens.inputTokens);
  elements.tokensOutput.textContent = formatNumber(overview.tokens.outputTokens);
  elements.tokensTotal.textContent = formatNumber(overview.tokens.totalTokens);
  elements.tokensWith.textContent = formatNumber(overview.tokens.jobsWithUsage);
  elements.tokensWithout.textContent = formatNumber(overview.tokens.jobsWithoutUsage);

  renderActiveJobs(overview.activeJobs || []);
  renderActiveAgents(overview.activeAgents || []);
}

function renderActiveJobs(activeJobs) {
  if (!activeJobs.length) {
    elements.activeJobsBody.innerHTML = '<tr><td colspan="5" class="empty">No active jobs.</td></tr>';
    return;
  }

  elements.activeJobsBody.innerHTML = activeJobs
    .map((job) => {
      const selectedClass = state.selectedJobId === job.id ? 'selected' : '';
      return `
        <tr class="job-row ${selectedClass}" data-job-id="${job.id}">
          <td>${statusPill(job.status)}</td>
          <td>${job.mode}</td>
          <td>${job.provider}</td>
          <td>${job.task}</td>
          <td>${formatAgo(job.updatedAt)}</td>
        </tr>
      `;
    })
    .join('');

  for (const row of elements.activeJobsBody.querySelectorAll('.job-row')) {
    row.addEventListener('click', () => {
      const nextJobId = row.getAttribute('data-job-id');
      if (!nextJobId || nextJobId === state.selectedJobId) return;
      selectJob(nextJobId);
    });
  }
}

function renderActiveAgents(activeAgents) {
  if (!activeAgents.length) {
    elements.activeAgentsBody.innerHTML = '<tr><td colspan="5" class="empty">No active agents.</td></tr>';
    return;
  }

  elements.activeAgentsBody.innerHTML = activeAgents
    .map(
      (agent) => `
      <tr>
        <td>${agent.jobId.slice(0, 8)}...</td>
        <td>${agent.role}</td>
        <td>${agent.workerId || 'N/A'}</td>
        <td>${statusPill(agent.status)}</td>
        <td>${formatAgo(agent.lastHeartbeatAt)}</td>
      </tr>
    `,
    )
    .join('');
}

function renderTeamSnapshot() {
  if (!state.teamSnapshot) {
    elements.teamStateView.textContent = 'N/A';
    return;
  }

  const snapshot = {
    status: state.teamSnapshot.status,
    phase: state.teamSnapshot.phase,
    currentTaskId: state.teamSnapshot.currentTaskId ?? null,
    metrics: state.teamSnapshot.metrics ?? null,
    tasks: Array.isArray(state.teamSnapshot.tasks)
      ? state.teamSnapshot.tasks.map((task) => ({
          id: task.id,
          role: task.role,
          status: task.status,
          attempt: task.attempt,
          workerId: task.workerId ?? null,
          startedAt: task.startedAt ?? null,
          finishedAt: task.finishedAt ?? null,
        }))
      : [],
  };

  elements.teamStateView.textContent = JSON.stringify(snapshot, null, 2);
}

function renderEvents() {
  if (!state.events.length) {
    elements.eventsList.innerHTML = '<li class="empty">No events yet.</li>';
    return;
  }

  elements.eventsList.innerHTML = state.events
    .slice()
    .reverse()
    .map(
      (event) => `
      <li>
        <span class="when">${formatTime(event.createdAt)}</span>
        <span class="event-type">${event.type}</span>
        <div>${event.message}</div>
      </li>
    `,
    )
    .join('');
}

function pushEvent(event) {
  if (!event || !event.id || state.eventIds.has(event.id)) return;
  state.eventIds.add(event.id);
  state.events.push(event);
  if (state.events.length > 200) {
    const removed = state.events.splice(0, state.events.length - 200);
    for (const old of removed) {
      state.eventIds.delete(old.id);
    }
  }
  renderEvents();
}

async function refreshOverview() {
  try {
    const overview = await readJson('/v1/monitor/overview?limit=200');
    state.overview = overview;
    renderOverview();
    setRefreshNote(`Last refreshed ${formatTime(overview.generatedAt)}`);

    if (!state.selectedJobId && overview.activeJobs.length > 0) {
      await selectJob(overview.activeJobs[0].id);
      return;
    }

    if (
      state.selectedJobId &&
      !overview.activeJobs.find((job) => job.id === state.selectedJobId)
    ) {
      clearSelection('Selected job is no longer active.');
    }
  } catch (error) {
    setRefreshNote(`Overview unavailable: ${error.message}`);
  }
}

function disconnectEvents() {
  if (state.eventSource) {
    state.eventSource.close();
    state.eventSource = null;
  }
}

function clearSelection(note = 'Select an active job to inspect details.') {
  disconnectEvents();
  state.selectedJobId = null;
  state.teamSnapshot = null;
  state.events = [];
  state.eventIds.clear();
  elements.selectedJobLabel.textContent = note;
  renderTeamSnapshot();
  renderEvents();
  renderOverview();
}

async function refreshTeamSnapshot(jobId) {
  try {
    const job = await readJson(`/v1/jobs/${encodeURIComponent(jobId)}`);
    if (job.mode !== 'team') {
      state.teamSnapshot = {
        status: job.status,
        phase: job.mode,
        currentTaskId: null,
        tasks: [],
      };
      renderTeamSnapshot();
      return;
    }

    state.teamSnapshot = await readJson(`/v1/jobs/${encodeURIComponent(jobId)}/team`);
    renderTeamSnapshot();
  } catch (error) {
    elements.teamStateView.textContent = `Failed to load team snapshot: ${error.message}`;
  }
}

function connectEvents(jobId) {
  disconnectEvents();
  const source = new EventSource(`/v1/jobs/${encodeURIComponent(jobId)}/events`);
  source.onmessage = (message) => {
    try {
      const event = JSON.parse(message.data);
      pushEvent(event);
    } catch {
      // Ignore malformed event payloads.
    }
  };
  source.onerror = () => {
    setRefreshNote(`Event stream disconnected for ${jobId.slice(0, 8)}..., retrying via browser.`);
  };
  state.eventSource = source;
}

async function selectJob(jobId) {
  state.selectedJobId = jobId;
  state.teamSnapshot = null;
  state.events = [];
  state.eventIds.clear();
  elements.selectedJobLabel.textContent = `Job ${jobId}`;
  renderOverview();
  renderTeamSnapshot();
  renderEvents();
  await refreshTeamSnapshot(jobId);
  connectEvents(jobId);
}

elements.refreshNow.addEventListener('click', () => {
  refreshOverview();
  if (state.selectedJobId) {
    refreshTeamSnapshot(state.selectedJobId);
  }
});

setInterval(() => {
  if (!elements.autoRefresh.checked) return;
  refreshOverview();
}, POLL_MS);

setInterval(() => {
  if (!elements.autoRefresh.checked || !state.selectedJobId) return;
  refreshTeamSnapshot(state.selectedJobId);
}, TEAM_REFRESH_MS);

window.addEventListener('beforeunload', () => disconnectEvents());

refreshOverview();

