from __future__ import annotations

from dataclasses import dataclass
from enum import Enum

from dev_crew.models import DEFAULT_AGENT_ROLES


class AccessMode(str, Enum):
    READ_ONLY = "read_only"
    WRITE = "write"


@dataclass
class PermissionPolicy:
    execution_agent_role: str

    def mode_for(self, role: str) -> AccessMode:
        if role == self.execution_agent_role:
            return AccessMode.WRITE
        return AccessMode.READ_ONLY

    def can_write(self, role: str) -> bool:
        return self.mode_for(role) == AccessMode.WRITE


def default_permission_policy(execution_agent_role: str) -> PermissionPolicy:
    if execution_agent_role not in DEFAULT_AGENT_ROLES:
        raise ValueError(
            f"execution_agent_role must be one of {DEFAULT_AGENT_ROLES}, got: {execution_agent_role}"
        )
    return PermissionPolicy(execution_agent_role=execution_agent_role)
