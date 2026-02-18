from dev_crew.models import JobRecord
from dev_crew.orchestration import CrewAIOrchestrator


def test_crewai_orchestrator_declares_parallel_tasks() -> None:
    job = JobRecord(
        job_id="job-crewai-1",
        goal="Integrate crewai",
        repo="org/repo",
        base_branch="main",
        work_branch="crew/job-crewai-1",
    )

    orchestrator = CrewAIOrchestrator(
        workspace_root=".",
        enabled=True,
        dry_run=True,
        llm=None,
        manager_llm=None,
        verbose=False,
    )
    result = orchestrator.run(job)

    assert result.metadata["enabled"] is True
    assert result.metadata["dry_run"] is True

    tasks = result.metadata["tasks"]
    assert any(task["role"] == "leader" for task in tasks)

    specialist = [task for task in tasks if task["role"] != "leader"]
    assert specialist
    assert all(task["async_execution"] is True for task in specialist)

    leader = [task for task in tasks if task["role"] == "leader"]
    assert len(leader) == 1
    assert leader[0]["async_execution"] is False
