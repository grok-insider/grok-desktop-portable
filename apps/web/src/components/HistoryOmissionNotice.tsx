import type { HistoryOmission } from "../services/sessionProjection";

/** States what the host left out of a conversation's history, never implying it is complete. */
export function HistoryOmissionNotice({ history, where }: { history: HistoryOmission; where: string }) {
  return (
    <p
      className="rounded-md bg-muted px-3 py-2 text-body-sm text-muted-foreground"
      data-omitted-messages={history.omittedMessages}
      data-history-truncated={history.truncated ? "true" : undefined}
    >
      {history.omittedMessages > 0
        ? `${history.omittedMessages === 1 ? "1 earlier message is" : `${history.omittedMessages} earlier messages are`} not shown ${where}. Your computer keeps a limited window of this conversation for reconnecting devices.`
        : `Part of this conversation's earlier history is not shown ${where}.`}
    </p>
  );
}
