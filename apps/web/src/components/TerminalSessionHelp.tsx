export function TerminalSessionHelp({className}: {className?: string}) {
  return <p className={className}>
    For live terminal control, start Grok with <code>grok --leader</code> using the same computer account and <code>GROK_HOME</code> as Spanreed.
    {" "}If a session was started without the shared leader, finish its current turn, exit, then reopen it with <code>grok --leader --resume &lt;session-id&gt;</code>.
  </p>;
}
