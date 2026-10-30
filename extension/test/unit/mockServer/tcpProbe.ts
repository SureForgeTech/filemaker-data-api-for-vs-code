import net from 'net';

export type TcpProbeResult = { reachable: true } | { reachable: false; reason: string };

/** The part of a socket the probe uses; a test can pass a fake one to make a timeout deterministic. */
export type ProbeSocket = Pick<net.Socket, 'once' | 'removeAllListeners' | 'destroy'>;
/** The part of a listening server the probe uses. */
export type ProbeServer = Pick<net.Server, 'on' | 'removeListener'>;

/**
 * Checks that a plain TCP connection to a listening server really reaches it: the client must
 * connect AND the server must accept that connection. The client side alone is not enough. On a
 * Mac with a firewall or network filter the kernel completes the handshake for a connection to the
 * machine's own LAN address, but the program listening there never sees it, so a TLS read on that
 * connection waits until it times out.
 *
 * Nothing is written, so no credentials or request data can be sent. The probe socket is always
 * destroyed, the timer is always cleared and the listener it adds to the server is always removed.
 * The server's own connection handler still runs for the probe connection, so the server must
 * tolerate a client that connects and closes at once.
 */
export function probeTcpAccept(
  server: ProbeServer,
  host: string,
  port: number,
  timeoutMs = 3000,
  connect: (port: number, host: string) => ProbeSocket = (p, h) => net.connect(p, h)
): Promise<TcpProbeResult> {
  return new Promise((resolve) => {
    const socket = connect(port, host);
    let connected = false;
    let accepted = false;
    let timer: NodeJS.Timeout | undefined;
    const finish = (result: TcpProbeResult): void => {
      clearTimeout(timer);
      server.removeListener('connection', onAccept);
      socket.removeAllListeners();
      // Keep a handler so an error that lands after we gave up cannot become an uncaught exception.
      socket.once('error', () => undefined);
      socket.destroy();
      resolve(result);
    };
    const settle = (): void => {
      if (connected && accepted) finish({ reachable: true });
    };
    const onAccept = (): void => {
      accepted = true;
      settle();
    };
    server.on('connection', onAccept);
    timer = setTimeout(
      () => finish({ reachable: false, reason: `${host}:${port} ${connected ? 'completed a TCP handshake but the listener never accepted the connection' : 'did not complete a TCP connection'} within ${timeoutMs} ms` }),
      timeoutMs
    );
    socket.once('connect', () => {
      connected = true;
      settle();
    });
    socket.once('error', (error: NodeJS.ErrnoException) => finish({ reachable: false, reason: `${error.code ?? 'error'} connecting to ${host}:${port}` }));
  });
}
