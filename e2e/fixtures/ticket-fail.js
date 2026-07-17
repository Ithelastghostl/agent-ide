// Deterministic failing stand-in for the headless ticket pass: the crash-safety
// spec asserts the session stays 'deployed' with a retryable error.
process.stderr.write('fixture: ticket pass failed')
process.exit(1)
