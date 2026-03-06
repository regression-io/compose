## Stratum Execution Model

Stratum is optional. If `capabilities.stratum` is false in `.compose/compose.json` (or stratum-mcp is not installed), skip Stratum steps and use flat prompt chains instead.

For non-trivial tasks when Stratum is available, use it internally:
1. Write a `.stratum.yaml` spec — never show it to the user
2. Call `stratum_plan` to validate and get the first step
3. Narrate progress in plain English as you execute each step
4. Call `stratum_step_done` after each step — the server checks your work
5. If a step fails postconditions, fix it silently and retry
6. Call `stratum_audit` at the end and include the trace in the commit
