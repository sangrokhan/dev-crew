from __future__ import annotations

from .models import CustomLLMConfig, LLMRequest, ProviderId


class ProviderRouter:
    def __init__(self, config: CustomLLMConfig) -> None:
        self.config = config

    def resolve_provider(self, request: LLMRequest) -> ProviderId:
        if request.preferred_provider:
            return request.preferred_provider

        model_lower = request.model.lower()
        for prefix, provider in self.config.model_routes.items():
            if model_lower.startswith(prefix):
                return provider
        return self.config.default_provider
