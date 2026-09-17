# Independent Architecture Review Prompt

Review this repository as a skeptical senior systems engineer.

Focus on:
- correctness of the Conversation Tree model;
- distinction between persistent branches and transient AgentRuns;
- arbitrary historical-turn fork feasibility;
- Claude CLI/SDK coupling;
- process/session lifecycle;
- event attribution;
- concurrency races;
- user + automation writing to one branch;
- filesystem/worktree semantics;
- security and secret leakage;
- restart/crash recovery;
- scalability to many branches and events.

Do not merely summarize.

Return:
1. Blockers
2. High-risk issues
3. Medium-risk issues
4. Missing tests
5. Concrete recommended changes
6. Gate verdict: PASS / FAIL
