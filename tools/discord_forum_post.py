"""Discord forum post tool — explicit-title forum posting for cron jobs.

Why this exists: cron jobs that auto-deliver to a Discord forum channel get
their thread title derived from the first line of the model's final reply
(``_derive_forum_thread_name``).  When the model emits stray verification
lines first, the wrong text becomes the thread title.

This tool gives the agent an explicit, deterministic path: the caller passes
``title`` and ``message`` as separate parameters, and the title is used
verbatim (capped at Discord's 100-char thread-name limit) as the new thread's
name.  Cron jobs should pair this with ``deliver: local`` so the only post
into the forum comes from this tool call, never from auto-delivery.

Registered in the ``discord_post`` toolset so it can be enabled per cron job
without pulling in the full Discord management surface.
"""

import json
import logging
import re
from typing import Optional

from agent.secret_scope import get_secret
from tools.registry import registry, tool_error

logger = logging.getLogger(__name__)

# Discord snowflakes are numeric; also accept channel names like "#n54-news".
_NUMERIC_ID_RE = re.compile(r"^\s*(-?\d+)\s*$")

DISCORD_FORUM_POST_SCHEMA = {
    "name": "discord_forum_post",
    "description": (
        "Post a message to a Discord FORUM channel as a new thread with an EXPLICIT "
        "title. Use this for scheduled digests/news posts so the thread title is "
        "exactly what you specify (e.g. '📈 持仓与半导体市场快讯｜2026-08-13') instead of "
        "being guessed from the message's first line. 'target' is a Discord forum "
        "channel id or channel name (e.g. 'discord:#n54-news'). 'title' is used "
        "verbatim as the thread name (max 100 chars). 'tags' optionally applies "
        "forum tags by name (e.g. ['news', 'stock']); unknown names are ignored. "
        "Returns the created thread id."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "target": {
                "type": "string",
                "description": "Discord forum channel: numeric id (e.g. '1475686669192663216') or name (e.g. '#n54-news' or 'n54-news').",
            },
            "title": {
                "type": "string",
                "description": "Exact thread/post title, used verbatim (capped at 100 chars). E.g. 'AI 新闻简报｜2026-08-13'.",
            },
            "message": {
                "type": "string",
                "description": "Full post body content (Discord Markdown). Long messages are chunked automatically and stay inside the created thread.",
            },
            "tags": {
                "type": "array",
                "items": {"type": "string"},
                "description": "Optional forum tag names to apply to the new post (e.g. ['news'] or ['stock']). Matched against the forum channel's available tags; unknown names are ignored.",
            },
        },
        "required": ["target", "title", "message"],
    },
}


def _resolve_discord_chat_id(target: str) -> Optional[str]:
    """Resolve a numeric Discord channel id or channel name to a chat id."""
    target = (target or "").strip()
    if not target:
        return None
    if _NUMERIC_ID_RE.fullmatch(target):
        return target
    try:
        from gateway.channel_directory import resolve_channel_name
        resolved = resolve_channel_name("discord", target)
        if resolved:
            # resolved may be "chat_id" or "chat_id:thread_id"; forum targets
            # are channels, take the first component.
            return resolved.split(":")[0]
    except Exception:
        logger.debug("resolve_channel_name failed for %s", target, exc_info=True)
    return None


def _discord_forum_post_tool(args):
    target = (args.get("target") or "").strip()
    title = (args.get("title") or "").strip()
    message = (args.get("message") or "").strip()
    tags = args.get("tags")
    if isinstance(tags, str):
        tags = [t.strip() for t in tags.split(",") if t.strip()]
    tags = tags if isinstance(tags, list) else None
    if not target or not title or not message:
        return tool_error(
            "'target', 'title' and 'message' are all required for action='send'"
        )

    chat_id = _resolve_discord_chat_id(target)
    if not chat_id:
        return tool_error(
            f"Could not resolve Discord forum target '{target}'. Use a numeric "
            f"channel id (e.g. '1475686669192663216') or a known channel name."
        )

    try:
        from gateway.config import Platform, load_gateway_config
        config = load_gateway_config()
        platform = Platform("discord")
    except Exception as e:
        return tool_error(f"Failed to load gateway config: {e}")

    pconfig = config.platforms.get(platform)
    if not pconfig or not pconfig.enabled:
        token = (get_secret("DISCORD_BOT_TOKEN", "") or "").strip()
        if not token:
            return tool_error(
                "Discord platform is not configured. Set up credentials in "
                "~/.hermes/config.yaml or environment variables."
            )
        from gateway.config import PlatformConfig
        pconfig = PlatformConfig(enabled=True, token=token)

    try:
        from gateway.platform_registry import platform_registry
        entry = platform_registry.get("discord")
        if entry is None or entry.standalone_sender_fn is None:
            return tool_error("Discord plugin not registered or missing standalone_sender_fn")

        from gateway.platforms.base import BasePlatformAdapter
        from model_tools import _run_async

        # Chunk long bodies (Discord hard limit 2000/msg) BEFORE the first
        # send. The first chunk creates the forum thread with the explicit
        # title; every follow-up chunk is posted INTO that same thread via its
        # returned thread_id, so a long post never spawns separate top-level
        # forum threads.
        chunks = BasePlatformAdapter.truncate_message(message, 2000)
        result = None
        thread_id = None
        for i, chunk in enumerate(chunks):
            is_first = (i == 0)
            result = _run_async(
                entry.standalone_sender_fn(
                    pconfig,
                    chat_id,
                    chunk,
                    title=title if is_first else None,
                    thread_id=None if is_first else thread_id,
                    tags=tags if is_first else None,
                )
            )
            if isinstance(result, dict) and result.get("error"):
                return json.dumps(result, ensure_ascii=False)
            if isinstance(result, dict) and result.get("thread_id") and not thread_id:
                thread_id = result["thread_id"]
        # Follow-up chunk results carry message_id but no thread_id; re-attach
        # the thread created by the first chunk so the caller (cron agent)
        # always sees the canonical post id in the payload.
        if (
            thread_id
            and isinstance(result, dict)
            and not result.get("thread_id")
        ):
            result = {**result, "thread_id": thread_id}
    except Exception as e:
        return tool_error(f"Discord forum post failed: {e}")

    if isinstance(result, dict) and result.get("error"):
        return json.dumps(result, ensure_ascii=False)

    if isinstance(result, dict) and result.get("success"):
        payload = {
            "success": True,
            "platform": "discord",
            "chat_id": chat_id,
            "thread_id": result.get("thread_id"),
            "message_id": result.get("message_id"),
            "title": title[:100],
        }
        if result.get("warnings"):
            payload["warnings"] = result["warnings"]
        return json.dumps(payload, ensure_ascii=False)

    return json.dumps(
        {"error": f"Discord forum post returned an unexpected result: {result!r}"},
        ensure_ascii=False,
    )


def check_discord_forum_post_requirements() -> bool:
    """Tool is available whenever a Discord bot token is configured."""
    try:
        return bool((get_secret("DISCORD_BOT_TOKEN", "") or "").strip())
    except Exception:
        return False


registry.register(
    name="discord_forum_post",
    toolset="discord_post",
    schema=DISCORD_FORUM_POST_SCHEMA,
    handler=lambda args, **kw: _discord_forum_post_tool(args),
    check_fn=check_discord_forum_post_requirements,
    requires_env=["DISCORD_BOT_TOKEN"],
    emoji="📣",
)
