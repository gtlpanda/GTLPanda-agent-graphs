export const meta = {
  name: 'calls-child',
  description: 'Fixture: calls one agent, then a child workflow, and returns what the child returned',
}
const first = await agent('first', { agentType: 'checker', label: 'first' })
const child = await workflow('child-graph', { repo: args.repo, from: first })
return { child }
