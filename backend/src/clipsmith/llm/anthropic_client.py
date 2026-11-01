"""Anthropic implementation of StructuredLLM: forces a tool call so output is always schema-shaped JSON."""
from __future__ import annotations

from typing import Any


class AnthropicClient:
    def __init__(self, api_key: str, model: str, max_tokens: int = 8000):
        import anthropic  # imported lazily: the core pipeline doesn't need the SDK

        self._client = anthropic.Anthropic(api_key=api_key)  # SDK retries 429/5xx by default
        self._model = model
        self._max_tokens = max_tokens

    def call_tool(self, *, system: str, user: str, tool_name: str, tool_description: str,
                  schema: dict[str, Any]) -> dict[str, Any]:
        resp = self._client.messages.create(
            model=self._model,
            max_tokens=self._max_tokens,
            system=system,
            messages=[{"role": "user", "content": user}],
            tools=[{"name": tool_name, "description": tool_description, "input_schema": schema}],
            tool_choice={"type": "tool", "name": tool_name},
        )
        for block in resp.content:
            if getattr(block, "type", None) == "tool_use":
                return dict(block.input)
        raise RuntimeError("LLM did not return the expected tool call")
