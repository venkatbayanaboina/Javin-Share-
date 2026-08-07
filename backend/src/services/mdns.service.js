import mdns from 'multicast-dns';

export function startMdnsResponder(customHost, localIP, logger) {
  if (!customHost || !customHost.toLowerCase().endsWith('.local')) {
    return null;
  }

  try {
    const mdnsInstance = mdns();

    mdnsInstance.on('query', (query) => {
      if (!query.questions) return;

      const targetHost = customHost.toLowerCase();

      query.questions.forEach((q) => {
        const queryName = q.name.endsWith('.') ? q.name.slice(0, -1) : q.name;

        if (q.type === 'A' && queryName.toLowerCase() === targetHost) {
          if (logger) {
            logger.info(`mDNS: Query received for ${q.name}, answering with IP ${localIP}`);
          }

          mdnsInstance.respond({
            answers: [
              {
                name: q.name,
                type: 'A',
                ttl: 120,
                data: localIP,
              },
            ],
          });
        }
      });
    });

    if (logger) {
      logger.info(`mDNS responder active for local name: ${customHost}`);
    }
    return mdnsInstance;
  } catch (err) {
    if (logger) {
      logger.error('Failed to initialize mDNS responder:', err);
    }
    return null;
  }
}
