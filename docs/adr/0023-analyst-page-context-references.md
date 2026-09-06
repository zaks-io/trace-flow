# Trace Flow Analyst uses page context references

For active Pro subscriptions, Trace Flow Analyst exposes a collapsible right-side Analyst Sidebar, and the Web app may attach selected page context to the user's next message. The sidebar and its Context Selection Mode are not available on Hobby. On the Agents page, Context Selection Mode lets the user select one or more analytics boxes; those selections are sent as structured Page Context References rather than screenshots, DOM scrapes, or copy-pasted text.

Context Selection Mode exists only while the Analyst Sidebar is open. Closing the sidebar, switching Analyst Threads, or sending a message clears unsent Page Context References.

Selectable page objects toggle when clicked. The Analyst Sidebar shows selected Page Context References as removable chips above the composer so the user can see and control exactly what page context will be attached.

The Web app should submit compact Page Context Reference identifiers and display metadata with the user message, not trust client-provided analytics data as authoritative. Convex resolves the referenced data for the Analyst Runtime using the current user's current permissions.

This is only possible because Trace Flow Analyst is integrated into the Web app and backed by Convex reactivity. MCP tools can answer data questions, but they cannot know which on-screen dashboard object the user is pointing at without the frontend attaching that page context explicitly.
