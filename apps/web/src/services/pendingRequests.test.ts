import { expect, it } from "vitest";
import { enqueueRequest, removeRequest } from "./pendingRequests";

it("queues requests without overwriting another request from the same session", () => {
  const first = {sessionId: "session", requestId: "first", title: "first"};
  const second = {...first, requestId: "second", title: "second"};
  let requests = enqueueRequest({}, first);
  requests = enqueueRequest(requests, second);
  requests = enqueueRequest(requests, {...first, title: "replayed"});
  expect(requests.session).toEqual([{...first, title: "replayed"}, second]);
  expect(removeRequest(requests, second).session).toEqual([{...first, title: "replayed"}]);
  expect(removeRequest(removeRequest(requests, second), first)).toEqual({});
});

it("never removes another session's request with the same request id", () => {
  const first = {sessionId: "one", requestId: "same"};
  const second = {sessionId: "two", requestId: "same"};
  const requests = enqueueRequest(enqueueRequest({}, first), second);
  expect(removeRequest(requests, first)).toEqual({two: [second]});
});
