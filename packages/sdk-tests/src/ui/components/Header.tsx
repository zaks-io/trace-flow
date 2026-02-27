import { Box, Text } from 'ink';

interface HeaderProps {
  scenario?: string | null;
  traceId?: string | null;
  proxyUrl?: string;
}

export function Header({ scenario, traceId, proxyUrl }: HeaderProps) {
  const traceShort = traceId ? traceId.slice(0, 24) : '—';

  return (
    <Box flexDirection="column" borderStyle="double" borderColor="#6366f1" paddingX={2}>
      <Box justifyContent="space-between">
        <Text bold color="#e0e7ff">
          TRACE FLOW <Text color="#6366f1">SDK TESTS</Text>
        </Text>
      </Box>
      <Box gap={4}>
        {scenario && (
          <Text dimColor>
            scenario:{' '}
            <Text color="#e0e7ff" bold>
              {scenario}
            </Text>
          </Text>
        )}
        <Text dimColor>
          trace: <Text color="#67e8f9">{traceShort}</Text>
        </Text>
        {proxyUrl && (
          <Text dimColor>
            proxy: <Text color="#a5b4fc">{proxyUrl.replace('http://', '')}</Text>
          </Text>
        )}
      </Box>
    </Box>
  );
}
