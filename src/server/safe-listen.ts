// Fetch blocks HTTP(S) requests to these ports even on loopback. Keep this list
// aligned with the WHATWG Fetch Standard's "bad port" table.
const FETCH_BAD_PORTS = new Set<number>([
  0, 1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69,
  77, 79, 87, 95, 101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123,
  135, 137, 139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515, 526, 530,
  531, 532, 540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993, 995, 1719,
  1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666,
  6667, 6668, 6669, 6679, 6697, 10080,
]);

export const DEFAULT_FETCH_SAFE_PORT_ATTEMPTS = 16;

export interface ListeningEndpoint<T> {
  resource: T;
  port: number;
  close(): Promise<void>;
}

export function isFetchBlockedPort(port: number): boolean {
  return FETCH_BAD_PORTS.has(port);
}

/**
 * Accepts an already-listening endpoint, then closes and retries only when the
 * OS-selected port is one browsers refuse to fetch. This deliberately avoids a
 * probe-then-bind race: the returned endpoint owns the port it was evaluated on.
 */
export async function selectFetchSafeListeningEndpoint<T>(
  openEndpoint: () => Promise<ListeningEndpoint<T>>,
  maxAttempts = DEFAULT_FETCH_SAFE_PORT_ATTEMPTS,
): Promise<ListeningEndpoint<T>> {
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1) {
    throw new Error("安全端口监听重试次数必须是大于零的整数");
  }

  const rejectedPorts: number[] = [];
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const endpoint = await openEndpoint();
    if (!Number.isSafeInteger(endpoint.port) || endpoint.port < 1 || endpoint.port > 65_535) {
      await endpoint.close();
      throw new Error(`本地服务监听器返回了无效端口：${endpoint.port}`);
    }
    if (!isFetchBlockedPort(endpoint.port)) return endpoint;

    rejectedPorts.push(endpoint.port);
    try {
      await endpoint.close();
    } catch (error) {
      throw new Error(`关闭浏览器禁止端口 ${endpoint.port} 上的监听器失败，已停止重试`, { cause: error });
    }
  }

  throw new Error(
    `本地服务连续 ${maxAttempts} 次被分配到浏览器禁止端口（${rejectedPorts.join(", ")}），未留下监听器`,
  );
}
