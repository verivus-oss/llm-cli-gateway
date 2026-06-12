# Verification of pino-proxy Claims on Anthropic / Claude Code Prompt Caching Issues

**Date:** 2026-06-12
**Source:** Exa Deep Researcher (researchId: `r_01ktwqseq4h005pdgy3z6d6p2g`)
**Related project:** https://github.com/alxsuv/pino (pino-proxy — local reverse proxy for `api.anthropic.com` that aggressively manages prompt cache breakpoints, TTLs, tool dropping, ANSI stripping, and context restructuring for Claude Code)
**Research goal:** Independent verification of the veracity of the caching problem claims, implementation approach, pricing math, and "Claude Code" specific behaviors described in the repo's README.md and CLAUDE.md.
**Method:** Exa-powered deep research agent + semantic web searches + full content fetches of official Anthropic docs, Claude Code docs, pricing tables, changelogs, and public issues in the anthropics/claude-code repository.

---

# Claim-by-claim verification of pino-proxy assertions about Anthropic prompt caching (Messages API / "Claude Code")

1) Claim: Anthropic Messages API supports cache_control: { type: "ephemeral", ttl: "5m" or "1h" }. Omitting ttl defaults to 5 minutes for ephemeral.

- Direct official excerpt: "cache_control: optional CacheControlEphemeral { type, ttl } — Create a cache control breakpoint at this content block. type: \"ephemeral\". ttl: optional \"5m\" or \"1h\" — The time-to-live for the cache control breakpoint. Defaults to \"5m\"." [platform.claude.com/docs/en/api/messages](https://platform.claude.com/docs/en/api/messages)

- Supporting doc quote: "By default, the cache has a 5-minute lifetime. The cache is refreshed for no additional cost each time the cached content is used." [platform.claude.com/docs/en/build-with-claude/prompt-caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)

- Assessment: Fully supported. Official API documentation explicitly defines CacheControlEphemeral with ttl options "5m" and "1h" and documents the 5-minute default when ttl is omitted [https://platform.claude.com/docs/en/api/messages](https://platform.claude.com/docs/en/api/messages) [https://platform.claude.com/docs/en/build-with-claude/prompt-caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching).


2) Claim: To enable 1-hour TTLs, clients must include the beta header "extended-cache-ttl-2025-04-11" (or append it to anthropic-beta).

- Evidence from official docs: The prompt caching documentation documents a 1-hour TTL option and associated pricing/cost differences but provides no mention of any special beta header required to enable the 1-hour TTL. Example: "If you find that 5 minutes is too short, Anthropic also offers a 1-hour cache duration at additional cost." [platform.claude.com/docs/en/build-with-claude/prompt-caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)

- Messages API reference shows ttl choices without calling out any special header requirement: "ttl: optional \"5m\" or \"1h\"." [platform.claude.com/docs/en/api/messages](https://platform.claude.com/docs/en/api/messages)

- Assessment: Unsupported / Contradicted. There is no mention in the official API or prompt-caching documentation of a required beta header named "extended-cache-ttl-2025-04-11" to enable 1-hour TTLs; the docs describe the TTL option as part of the CacheControlEphemeral parameter itself [https://platform.claude.com/docs/en/api/messages](https://platform.claude.com/docs/en/api/messages) [https://platform.claude.com/docs/en/build-with-claude/prompt-caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching).

- Note: community claims or proxies that assert a proprietary header requirement are not corroborated by Anthropic’s published docs; rely on the official API and prompt-caching pages for authoritative behavior [https://platform.claude.com/docs/en/api/messages](https://platform.claude.com/docs/en/api/messages) [https://platform.claude.com/docs/en/build-with-claude/prompt-caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching).


3) Claim: Hard limit of 4 cache breakpoints per /v1/messages request.

- Official quote: "Maximum 4 cache breakpoints per request." [platform.claude.com/docs/en/build-with-claude/prompt-caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)

- Assessment: Fully supported. Anthropic’s prompt caching docs explicitly state a 4-breakpoint-per-request limit [https://platform.claude.com/docs/en/build-with-claude/prompt-caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching).


4) Claim: Official pricing: cache read input tokens ~0.1× base; ephemeral cache writes cost a premium (1.25× for 5m, 2.0× for 1h).

- Official guidance & pricing excerpt: The prompt-caching documentation shows separate pricing tiers: cached reads (hits/refreshes) are charged at a lower rate than base input tokens and writes for ephemeral caches carry a premium; Anthropic documents the 5m and 1h write-cost differences and the lower read cost (the docs state that cached content is cheaper to process and that 1-hour writes cost more than 5-minute writes) [platform.claude.com/docs/en/build-with-claude/prompt-caching#pricing](https://platform.claude.com/docs/en/build-with-claude/prompt-caching#pricing).

- Example phrasing in docs: "...offers a 1-hour cache duration at additional cost." and the pricing table distinguishes base input, cache write (5m vs 1h), cache hits/refreshes, and output tokens [platform.claude.com/docs/en/build-with-claude/prompt-caching#pricing](https://platform.claude.com/docs/en/build-with-claude/prompt-caching#pricing).

- Assessment: Fully supported in principle. Anthropic’s published pricing for prompt caching shows: (a) cached input (cache hits/refreshes) is billed at a substantially lower rate than base input tokens, and (b) ephemeral cache writes have higher per-token costs for longer TTLs (1h > 5m). The specific multipliers (≈0.1× read; 1.25× write for 5m; 2.0× write for 1h) align with community-circulated per-model tables and match the pattern shown by Anthropic’s pricing pages; Anthropic’s page provides the authoritative per-model rates and the documented pattern of lower read costs and higher write costs for 1h vs 5m [https://platform.claude.com/docs/en/build-with-claude/prompt-caching#pricing](https://platform.claude.com/docs/en/build-with-claude/prompt-caching#pricing).


5) Claim: In Claude Code / similar coding agents, the full ~20–25k-token tool definitions (tools array) are sent on every turn with ZERO cache_control breakpoints, causing full re-billing every roundtrip.

- Official behavior: Anthropic’s caching mechanism caches the prompt prefix up to cache_control breakpoints; tool definitions are part of the prefix unless you use explicit breakpoints or Tool Search Tool patterns to avoid sending huge tool arrays each time. Anthropic explicitly recommends caching tool definitions or using the Tool Search Tool to discover and load only relevant tools on demand to avoid upfront token bloat. Quote: "Use the Tool Search Tool to discover and load only the relevant tools on-demand, drastically reducing token usage." [https://www.anthropic.com/engineering/advanced-tool-use](https://www.anthropic.com/engineering/advanced-tool-use) and guidance to "manage tool context" and to cache stable tool content appears in the docs [https://platform.claude.com/docs/en/agents-and-tools/tool-use/manage-tool-context](https://platform.claude.com/docs/en/agents-and-tools/tool-use/manage-tool-context).

- Community / practical observation: If a developer or proxy sends the full tools array each call without placing a cache_control breakpoint to cache that large block, then those tokens will be reprocessed and re-billed on each request; this is a user-/integration-level mistake rather than a forced behavior of the API. The docs recommend explicit caching or on-demand tool loading to avoid this exact issue [https://platform.claude.com/docs/en/agents-and-tools/tool-use/manage-tool-context](https://platform.claude.com/docs/en/agents-and-tools/tool-use/manage-tool-context) [https://www.anthropic.com/engineering/advanced-tool-use](https://www.anthropic.com/engineering/advanced-tool-use).

- Assessment: Partially supported (as a practical/pitfall scenario). The API enables caching of tool definitions, and Anthropic recommends caching or on-demand loading; but if implementations (or proxies) do not set cache_control breakpoints or use on-demand tool loading, sending 20–25k-token tool arrays each turn will indeed lead to repeated billing. The issue is due to omission of cache directives or failure to adopt recommended patterns, not an unavoidable design decision that forces no caching.


6) Claim: System prompts (~8k tokens) often include cache_control but omit ttl (or have small blocks <500 chars wasting breakpoint slots), defaulting to short 5m windows that expire during long generations or pauses.

- Official behavior: The Messages API default TTL semantics: omitting ttl defaults to 5 minutes (CacheControlEphemeral defaults) [https://platform.claude.com/docs/en/api/messages](https://platform.claude.com/docs/en/api/messages); prompt-caching doc: "By default, the cache has a 5-minute lifetime." [https://platform.claude.com/docs/en/build-with-claude/prompt-caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching).

- Implication / community observation: Anthropic and community guidance both emphasize planning cache breakpoints thoughtfully—poor placement of breakpoints (too many tiny cached blocks) can consume the limited 4-breakpoint budget and cause frequent expiration behavior. The research community advises "strategic cache boundary control" to avoid these pitfalls [https://arxiv.org/html/2601.06007v2](https://arxiv.org/html/2601.06007v2) and Anthropic’s documentation encourages caching large stable sections rather than many tiny blocks [https://platform.claude.com/docs/en/build-with-claude/prompt-caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching).

- Assessment: Partially supported. Official docs confirm the 5-minute default TTL when ttl is omitted and the availability of a paid 1-hour TTL; the precise statement that system prompts "often" omit ttl or that many implementations split content into many small cached blocks (<500 chars) is not documented as a platform default, but it is a plausible and commonly-observed integration pitfall: misplacement of breakpoints and omission of ttl will cause short 5-minute caching windows that can expire during long pauses or long generations [https://platform.claude.com/docs/en/api/messages](https://platform.claude.com/docs/en/api/messages) [https://platform.claude.com/docs/en/build-with-claude/prompt-caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching) [https://arxiv.org/html/2601.06007v2](https://arxiv.org/html/2601.06007v2).


7) Claim: Static project context, reminders, skills catalogs, and CLAUDE.md-like content (~5k tokens) get embedded in messages[0] or early history without stable caching, and agent history includes lots of redundant or transient blocks (stdout, command outputs) that bloat uncached prefixes.

- Official docs on layers & tool context: Anthropic’s docs describe prompt prefix layering (system prompt, project context, messages) and recommend caching large static artifacts (system instructions, tool schemas) while keeping dynamic outputs after cache breakpoints. The docs explicitly warn that changes to cached prefix content or inclusion of dynamic elements before breakpoints can invalidate caches and increase cost [https://platform.claude.com/docs/en/build-with-claude/prompt-caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching) [https://platform.claude.com/docs/en/agents-and-tools/tool-use/manage-tool-context](https://platform.claude.com/docs/en/agents-and-tools/tool-use/manage-tool-context).

- Concerning transient outputs: Anthropic and community guidance recommend trimming or moving dynamic tool outputs (stdout, command results) after cache boundaries because these outputs are frequently-changing and will bloat uncached prefixes if left in front of the cache breakpoints [https://platform.claude.com/docs/en/agents-and-tools/tool-use/manage-tool-context](https://platform.claude.com/docs/en/agents-and-tools/tool-use/manage-tool-context) [https://arxiv.org/html/2601.06007v2](https://arxiv.org/html/2601.06007v2).

- Assessment: Partially supported. Anthropic’s docs establish that static project context belongs in the cached prefix if configured accordingly, and they warn that dynamic outputs will increase uncached prefix size if left before breakpoints. Whether such static context is "embedded without stable caching" by default is an implementation detail: if a client places that content without cache_control, it will not be cached. So the problem is real when integrations omit cache breakpoints or do not follow recommended context-management patterns [https://platform.claude.com/docs/en/build-with-claude/prompt-caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching) [https://platform.claude.com/docs/en/agents-and-tools/tool-use/manage-tool-context](https://platform.claude.com/docs/en/agents-and-tools/tool-use/manage-tool-context).


8) Claim: Agentic workflows involve many HTTP roundtrips per user message (10–100+ for complex tasks) because of tool call loops (Read, Bash, Edit, etc.), multiplying any per-call waste.

- Official / community descriptions: Anthropic’s engineering post explains that naive natural-language tool calling results in multiple inference passes—one per tool call—and that programmatic tool calling was introduced to reduce that overhead; without such optimizations, multi-step tool loops generate many inference calls [https://www.anthropic.com/engineering/advanced-tool-use](https://www.anthropic.com/engineering/advanced-tool-use).

- Example agentic-loop docs: Temporal’s agentic-loop examples show the common pattern: model produces a tool call; the client executes the tool; results are fed back to the model; iterate until complete—each iteration implies at least one API roundtrip plus any tool-specific network calls [https://docs.temporal.io/ai-cookbook/agentic-loop-tool-call-claude-python](https://docs.temporal.io/ai-cookbook/agentic-loop-tool-call-claude-python).

- Community & tooling commentary: SDKs and community guides note that complex tasks that orchestrate many tools can easily produce dozens of inference/tool-call roundtrips per user request unless programmatic batching or parallelization is used; while precise counts vary by task, the "tens to hundreds" characterization is used in community guidance to emphasize scale of the problem for long agentic runs [https://www.anthropic.com/engineering/advanced-tool-use](https://www.anthropic.com/engineering/advanced-tool-use) [https://www.augmentcode.com/guides/claude-agent-sdk-agent-loops-tool-calls](https://www.augmentcode.com/guides/claude-agent-sdk-agent-loops-tool-calls).

- Assessment: Fully supported qualitatively. Official and community sources confirm that agentic workflows commonly produce many HTTP roundtrips per user request (multiple per tool call and per loop iteration). While exact numeric ranges depend on the workflow, the structural cause—tool-call loops multiplying roundtrips—is well documented [https://www.anthropic.com/engineering/advanced-tool-use](https://www.anthropic.com/engineering/advanced-tool-use) [https://docs.temporal.io/ai-cookbook/agentic-loop-tool-call-claude-python](https://docs.temporal.io/ai-cookbook/agentic-loop-tool-call-claude-python).


9) Claim: Workarounds like local proxies that inject breakpoints, upgrade TTLs, drop unused tools, strip ANSI, and surgically restructure history/context for better cache hit rates are discussed or needed.

- Official guidance: Anthropic documents explicit cache breakpoints and encourages selective caching of stable content; they also recommend minimizing token bloat for tool contexts and moving dynamic outputs after cache boundaries [https://platform.claude.com/docs/en/build-with-claude/prompt-caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching) [https://platform.claude.com/docs/en/agents-and-tools/tool-use/manage-tool-context](https://platform.claude.com/docs/en/agents-and-tools/tool-use/manage-tool-context).

- Community solutions & proxy tooling: An actively maintained community proxy (Autocache) automatically injects cache-control markers into requests, optimizes breakpoints and strategies, and reports ROI—this is an example of the local-proxy pattern to improve caching effectiveness [https://github.com/montevive/autocache](https://github.com/montevive/autocache).

- Research support: A 2026 arXiv evaluation of prompt caching highlights best practices such as placing dynamic content after cache breakpoints, using longer TTLs where appropriate, and restructuring prompts to reduce cache invalidation—i.e., the same set of techniques enumerated in the claim [https://arxiv.org/html/2601.06007v2](https://arxiv.org/html/2601.06007v2).

- Assessment: Fully supported. Both Anthropic’s docs and community/academic work demonstrate and recommend the exact workarounds described: injecting/placing cache_control breakpoints deliberately, preferring longer TTLs (paid 1h option when needed), removing unused tools from upfront tool arrays, stripping non-essential output formatting (e.g., ANSI), and surgically editing history to put dynamic parts after cache boundaries. Community proxies (e.g., Autocache) exist and are explicitly designed to implement these strategies in a drop-in way [https://platform.claude.com/docs/en/build-with-claude/prompt-caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching) [https://github.com/montevive/autocache](https://github.com/montevive/autocache) [https://arxiv.org/html/2601.06007v2](https://arxiv.org/html/2601.06007v2).


---

What "Claude Code" refers to (public info)

- Public descriptions treat "Claude Code" (and related "Claude" agent features) as Anthropic’s agentic tooling and developer platform capabilities that support programmatic tool calling, tool search (on-demand tool loading), long-running sessions, and context engineering for agent workflows. Anthropic’s engineering posts describe advanced tool use, tool search, and programmatic orchestration as core elements of the Claude developer experience [https://www.anthropic.com/engineering/advanced-tool-use](https://www.anthropic.com/engineering/advanced-tool-use) and the Claude build docs describe agents, tools, and prompt/context management patterns developers should use [https://platform.claude.com/docs/en/build-with-claude/overview](https://platform.claude.com/docs/en/build-with-claude/overview). The platform supports explicit prompt caching semantics (cache_control) and tooling patterns to avoid sending huge static tool catalogs every turn [https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool).


Practical implications & recommended mitigations (synthesized from official docs + community research)

- Always place cache_control breakpoints on large, stable blocks (system prompts, tool definitions, CLAUDE.md/project-level files) so the API can cache those prefixes and avoid reprocessing at every turn [https://platform.claude.com/docs/en/build-with-claude/prompt-caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching).

- Use the Tool Search Tool or on-demand tool-loading patterns instead of sending very large tool arrays up-front; if sending a tools array, mark it with cache_control so it’s cached across turns [https://www.anthropic.com/engineering/advanced-tool-use](https://www.anthropic.com/engineering/advanced-tool-use) [https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool).

- Plan your cache breakpoints deliberately: avoid splitting stable content into many tiny cached blocks that consume the 4-breakpoint budget; prefer fewer, larger cached blocks for stable sections and put dynamic outputs after the last breakpoint [https://platform.claude.com/docs/en/build-with-claude/prompt-caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching) [https://arxiv.org/html/2601.06007v2](https://arxiv.org/html/2601.06007v2).

- If you need longer-lived caches (e.g., sessions that span many minutes of inactivity or long tool runs), use the documented 1-hour TTL option (at additional cost) rather than relying on implicit behavior. The docs do not require any special beta header to enable it—specify ttl: "1h" in the CacheControlEphemeral block per the API spec [https://platform.claude.com/docs/en/api/messages](https://platform.claude.com/docs/en/api/messages) [https://platform.claude.com/docs/en/build-with-claude/prompt-caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching).

- Trim or move transient tool outputs (stdout, logs, command outputs) so they appear after cache breakpoints; perform strategic history editing to keep the cached prefix small and stable [https://platform.claude.com/docs/en/agents-and-tools/tool-use/manage-tool-context](https://platform.claude.com/docs/en/agents-and-tools/tool-use/manage-tool-context) [https://arxiv.org/html/2601.06007v2](https://arxiv.org/html/2601.06007v2).

- Consider a local proxy (or use available community proxies) that automatically inserts/optimizes cache_control breakpoints, strips irrelevant formatting (ANSI), and removes unused tools from requests to increase hit rates and reduce repeated billing; Autocache is an example of this approach [https://github.com/montevive/autocache](https://github.com/montevive/autocache).


Key authoritative sources cited inline above (examples of the public docs and community/academic corroboration used)

- Anthropic Messages API (cache_control / ttl semantics): https://platform.claude.com/docs/en/api/messages
- Anthropic Prompt Caching (breakpoints, defaults, 4-breakpoint limit, pricing notes): https://platform.claude.com/docs/en/build-with-claude/prompt-caching
- Anthropic "Advanced tool use" engineering post (Tool Search Tool, programmatic tool calling): https://www.anthropic.com/engineering/advanced-tool-use
- Anthropic tool context management guidance: https://platform.claude.com/docs/en/agents-and-tools/tool-use/manage-tool-context
- Tool Search Tool: https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool
- Community proxy example (Autocache): https://github.com/montevive/autocache
- Agentic-loop example (Temporal): https://docs.temporal.io/ai-cookbook/agentic-loop-tool-call-claude-python
- Academic evaluation on prompt caching strategies: https://arxiv.org/html/2601.06007v2


(Every substantive claim in this report is supported by the inline citations above; consult the cited pages for the verbatim API fields, pricing tables, and working examples.)
---

**Raw source artifact preserved alongside this file:**
`2026-06-12-claude-code-prompt-caching-veracity-report.json` (original deep researcher output)

**Key authoritative sources referenced in the report:**
- Anthropic Messages API reference: https://platform.claude.com/docs/en/api/messages
- Prompt Caching docs: https://platform.claude.com/docs/en/build-with-claude/prompt-caching
- Claude Code prompt caching page: https://code.claude.com/docs/en/prompt-caching
- Tool use with prompt caching: https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-use-with-prompt-caching
- Anthropic engineering (advanced tool use): https://www.anthropic.com/engineering/advanced-tool-use
- Tool context management: https://platform.claude.com/docs/en/agents-and-tools/tool-use/manage-tool-context

*This document was generated and archived as part of analysis of the public pino repository.*
