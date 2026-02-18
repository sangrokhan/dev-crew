from __future__ import annotations

from dataclasses import dataclass


class JobBudgetExceededError(RuntimeError):
    pass


@dataclass
class JobBudgetConfig:
    max_state_transitions: int = 20
    max_tool_calls: int = 10


class JobBudgetGuard:
    def __init__(self, config: JobBudgetConfig, initial_transitions: int = 0) -> None:
        self.config = config
        self.state_transitions = initial_transitions
        self.tool_calls = 0

    def consume_transition(self) -> None:
        self.state_transitions += 1
        if self.state_transitions > self.config.max_state_transitions:
            raise JobBudgetExceededError(
                f"max_state_transitions exceeded: {self.state_transitions}/"
                f"{self.config.max_state_transitions}"
            )

    def consume_tool_call(self) -> None:
        self.tool_calls += 1
        if self.tool_calls > self.config.max_tool_calls:
            raise JobBudgetExceededError(
                f"max_tool_calls exceeded: {self.tool_calls}/{self.config.max_tool_calls}"
            )
