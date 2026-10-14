interface RequestIdentity {sessionId: string; requestId: string}

export function enqueueRequest<T extends RequestIdentity>(current: Record<string, T[]>, request: T): Record<string, T[]> {
  const requests = current[request.sessionId] ?? [];
  const existing = requests.some((entry) => entry.requestId === request.requestId);
  return {...current, [request.sessionId]: existing ? requests.map((entry) => entry.requestId === request.requestId ? request : entry) : [...requests, request]};
}

export function removeRequest<T extends RequestIdentity>(current: Record<string, T[]>, request: RequestIdentity): Record<string, T[]> {
  const requests = current[request.sessionId];
  if (!requests?.some((entry) => entry.requestId === request.requestId)) return current;
  const next = {...current};
  const remaining = requests.filter((entry) => entry.requestId !== request.requestId);
  if (remaining.length) next[request.sessionId] = remaining;
  else delete next[request.sessionId];
  return next;
}
