from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable


class InMemoryJobQueue:
    def __init__(self) -> None:
        self._queue: asyncio.Queue[str | None] = asyncio.Queue()
        self._worker_task: asyncio.Task[None] | None = None

    async def start(self, processor: Callable[[str], Awaitable[None]]) -> None:
        if self._worker_task and not self._worker_task.done():
            return

        async def _runner() -> None:
            while True:
                job_id = await self._queue.get()
                if job_id is None:
                    self._queue.task_done()
                    break
                try:
                    await processor(job_id)
                finally:
                    self._queue.task_done()

        self._worker_task = asyncio.create_task(_runner())

    async def stop(self) -> None:
        if not self._worker_task:
            return
        await self._queue.put(None)
        await self._worker_task
        self._worker_task = None

    async def enqueue(self, job_id: str) -> None:
        await self._queue.put(job_id)
