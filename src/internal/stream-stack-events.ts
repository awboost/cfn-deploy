import {
  CloudFormationClient,
  paginateDescribeStackEvents,
  type StackEvent,
} from "@aws-sdk/client-cloudformation";
import { setTimeout as delay } from "timers/promises";

export async function* streamChangeSetEvents(
  client: CloudFormationClient,
  stackId: string,
  token: string,
): AsyncIterableIterator<StackEvent> {
  const rewind = await reverse(getEventsReverse(client, stackId, token));
  if (!rewind.length) {
    return;
  }

  yield* rewind;

  let last = rewind[rewind.length - 1]!.EventId;

  for (;;) {
    const events = await reverse(
      getEventsReverse(client, stackId, token, last),
    );
    if (events.length) {
      last = events[events.length - 1]!.EventId;
      yield* events;
    }
    await delay(1000);
  }
}

async function reverse<T>(iterator: AsyncIterable<T>): Promise<T[]> {
  const items: T[] = [];

  for await (const item of iterator) {
    items.unshift(item);
  }
  return items;
}

async function* getEventsReverse(
  client: CloudFormationClient,
  stackId: string,
  token: string,
  stopAtId?: string,
): AsyncIterableIterator<StackEvent> {
  const pages = paginateDescribeStackEvents({ client }, { StackName: stackId });

  for await (const page of pages) {
    for (const event of page.StackEvents!) {
      if (event.ClientRequestToken !== token || event.EventId === stopAtId) {
        return;
      }
      yield event;
    }
  }
}
