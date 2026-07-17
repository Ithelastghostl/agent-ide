// Deterministic stand-in for the headless ticket pass (AGENT_IDE_TICKET_CMD):
// consumes the prompt on stdin and emits a valid TicketFields JSON object.
let input = ''
process.stdin.on('data', (d) => { input += d })
process.stdin.on('end', () => {
  process.stdout.write(JSON.stringify({
    title: 'Fixture ticket',
    subkind: 'feature',
    problem: 'The widget needed shipping.',
    solution: 'Shipped the widget.',
    files_touched: ['src/widget.ts'],
    key_decisions: ['ship it'],
    follow_ups: [],
    test_status: 'green',
    deploy_ref: 'deploy-123'
  }))
  process.exit(0)
})
