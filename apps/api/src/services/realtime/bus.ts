import { createClient } from 'redis';
import { env } from '../../config/env.ts';
import { logger } from '../../utils/logger.ts';
import type { RealtimeEnvelope } from './payloads.ts';
import type { RealtimeEventType } from './eventCatalog.ts';

// In-process by default. With REDIS_URL set -- as in production, which runs two
// replicas -- publishes fan out via pub/sub so every replica delivers to its
// own sockets. A single dev process needs neither.

type Subscriber = (entry: RealtimeEnvelope) => void;

const CHANNEL = 'three-peaks:realtime';

const subscribers = new Set<Subscriber>();
let publisher: ReturnType<typeof createClient> | null = null;
let started = false;

export function subscribeToBus(subscriber: Subscriber): () => void {
  subscribers.add(subscriber);
  return () => subscribers.delete(subscriber);
}

function deliverLocally(entry: RealtimeEnvelope): void {
  for (const subscriber of subscribers) {
    try {
      subscriber(entry);
    } catch (error) {
      // One bad subscriber must not stop delivery to the others.
      logger.error('realtime subscriber threw', { error });
    }
  }
}

export async function startBus(): Promise<void> {
  if (started || !env.redisUrl) return;
  started = true;

  publisher = createClient({ url: env.redisUrl });
  const listener = publisher.duplicate();

  publisher.on('error', (error) => logger.error('redis publisher error', { error }));
  listener.on('error', (error) => logger.error('redis subscriber error', { error }));

  await publisher.connect();
  await listener.connect();

  await listener.subscribe(CHANNEL, (message) => {
    try {
      deliverLocally(JSON.parse(message) as RealtimeEnvelope);
    } catch (error) {
      logger.error('undeliverable realtime message', { error });
    }
  });
}

export async function publish<T extends RealtimeEventType>(
  entry: RealtimeEnvelope<T>
): Promise<void> {
  if (publisher) {
    // Redis echoes to every subscriber including this process's own listener,
    // so publishing locally as well would deliver each event twice.
    await publisher.publish(CHANNEL, JSON.stringify(entry)).catch((error) => {
      // A Redis outage degrades to this process only rather than losing the
      // event entirely for the clients this process is serving.
      logger.error('redis publish failed; delivering locally only', { error });
      deliverLocally(entry as RealtimeEnvelope);
    });
    return;
  }
  deliverLocally(entry as RealtimeEnvelope);
}

export function resetBusForTests(): void {
  subscribers.clear();
}
