import { useState } from 'react';
import { Box, Text } from 'ink';
import { MultiSelect, Select } from '@inkjs/ui';
import { getProviders } from '../../providers';
import { getAllScenarios } from '../../scenarios';
import { Header } from '../components/Header';
import { getProviderColor } from '../theme';

type SelectPhase = 'providers' | 'scenario';

const BACK_VALUE = '__back__';

interface SelectScreenProps {
  onSelect: (providerIds: string[], scenarioId: string) => void;
}

export function SelectScreen({ onSelect }: SelectScreenProps) {
  const [phase, setPhase] = useState<SelectPhase>('providers');
  const [selectedProviders, setSelectedProviders] = useState<string[]>([]);

  const allProviders = getProviders();
  const availableProviders = allProviders.filter((p) => process.env[p.envKey]);
  const unavailableProviders = allProviders.filter((p) => !process.env[p.envKey]);
  const allScenarios = getAllScenarios();

  if (phase === 'providers') {
    return (
      <Box flexDirection="column" gap={1}>
        <Header />
        <Box flexDirection="column">
          <Text bold color="#e0e7ff">
            Select providers to test:
          </Text>
          <Text dimColor>Space to toggle, Enter to confirm (all selected by default)</Text>
          {availableProviders.length === 0 ? (
            <Text color="#ef4444">No providers have API keys configured.</Text>
          ) : (
            <MultiSelect
              defaultValue={availableProviders.map((p) => p.id)}
              options={availableProviders.map((p) => ({
                label: `${p.name} (${p.model})`,
                value: p.id,
              }))}
              onSubmit={(values) => {
                if (values.length === 0) return;
                setSelectedProviders(values);
                setPhase('scenario');
              }}
            />
          )}
          {unavailableProviders.map((p) => (
            <Text key={p.id} dimColor>
              {'\u25cb'} {p.name} <Text color="#6b7280">({p.envKey} not set)</Text>
            </Text>
          ))}
        </Box>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" gap={1}>
      <Header />
      <Box flexDirection="column">
        <Text bold color="#e0e7ff">
          Providers:{' '}
          {selectedProviders.map((id, i) => (
            <Text key={id}>
              {i > 0 && ', '}
              <Text color={getProviderColor(id)}>{id}</Text>
            </Text>
          ))}
        </Text>
        <Text bold color="#e0e7ff">
          Select scenario:
        </Text>
        <Select
          options={[
            ...allScenarios.map((s) => ({
              label: `${s.name} — ${s.description}`,
              value: s.id,
            })),
            { label: '\u2190 Back to providers', value: BACK_VALUE },
          ]}
          onChange={(value) => {
            if (value === BACK_VALUE) {
              setPhase('providers');
              return;
            }
            onSelect(selectedProviders, value);
          }}
        />
      </Box>
    </Box>
  );
}
