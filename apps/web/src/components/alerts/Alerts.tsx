'use client';

import { type Preloaded, usePreloadedQuery, useMutation } from 'convex/react';
import { api } from '@convex/_generated/api';
import { useState } from 'react';
import type { Id, Doc } from '@convex/_generated/dataModel';
import { PageToolbar } from '@/components/shared/PageToolbar';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';
import { ChevronDown } from 'lucide-react';
import type { AlertField, AlertOperator, AlertSeverity } from '@/types/alerts';
import { ALERT_FIELD_LABELS, ALERT_OPERATOR_LABELS } from '@/types/alerts';

type Alert = Doc<'alerts'>;

interface AlertFormData {
  name: string;
  field: AlertField;
  operator: AlertOperator;
  value: string;
  severity: AlertSeverity;
}

const DEFAULT_FORM_DATA: AlertFormData = {
  name: '',
  field: 'duration_ms',
  operator: 'gt',
  value: '',
  severity: 'warning',
};

const ALERT_FIELDS: AlertField[] = [
  'duration_ms',
  'tokens_per_second',
  'total_tokens',
  'prompt_tokens',
  'completion_tokens',
  'ttft_ms',
  'is_error',
  'http_status_code',
  'cost_total',
];

const ALERT_OPERATORS: AlertOperator[] = ['gt', 'gte', 'lt', 'lte', 'eq', 'neq'];

const ALERT_SEVERITIES: AlertSeverity[] = ['info', 'warning', 'error'];

const severityStyles: Record<AlertSeverity, string> = {
  info: 'bg-blue-500/20 text-blue-400 border-blue-500/30',
  warning: 'bg-amber-500/20 text-amber-400 border-amber-500/30',
  error: 'bg-red-500/20 text-red-400 border-red-500/30',
};

interface SelectProps {
  value: string;
  onChange: (value: string) => void;
  options: { value: string; label: string }[];
  placeholder?: string;
}

function Select({ value, onChange, options, placeholder }: SelectProps) {
  const [open, setOpen] = useState(false);
  const selectedOption = options.find((o) => o.value === value);

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex w-full items-center justify-between rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs transition-colors hover:bg-muted/50"
      >
        <span className={selectedOption ? 'text-foreground' : 'text-muted-foreground'}>
          {selectedOption?.label ?? placeholder ?? 'Select...'}
        </span>
        <ChevronDown className="h-4 w-4 text-muted-foreground" />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute z-50 mt-1 w-full rounded-md border border-border bg-card py-1 shadow-lg">
            {options.map((option) => (
              <button
                key={option.value}
                type="button"
                onClick={() => {
                  onChange(option.value);
                  setOpen(false);
                }}
                className={cn(
                  'w-full px-3 py-2 text-left text-sm hover:bg-muted',
                  value === option.value && 'bg-muted font-medium',
                )}
              >
                {option.label}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

export default function Alerts({
  preloadedAlerts,
}: {
  preloadedAlerts: Preloaded<typeof api.alerts.list>;
}) {
  const alerts = usePreloadedQuery(preloadedAlerts);
  const createAlert = useMutation(api.alerts.create);
  const updateAlert = useMutation(api.alerts.update);
  const deleteAlert = useMutation(api.alerts.remove);
  const toggleAlert = useMutation(api.alerts.toggle);

  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [editingAlert, setEditingAlert] = useState<Alert | null>(null);
  const [formData, setFormData] = useState<AlertFormData>(DEFAULT_FORM_DATA);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [deletingId, setDeletingId] = useState<Id<'alerts'> | null>(null);
  const [togglingId, setTogglingId] = useState<Id<'alerts'> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const openCreateDialog = () => {
    setEditingAlert(null);
    setFormData(DEFAULT_FORM_DATA);
    setError(null);
    setIsDialogOpen(true);
  };

  const openEditDialog = (alert: Alert) => {
    setEditingAlert(alert);
    setFormData({
      name: alert.name,
      field: alert.field as AlertField,
      operator: alert.operator as AlertOperator,
      value: String(alert.value),
      severity: alert.severity as AlertSeverity,
    });
    setError(null);
    setIsDialogOpen(true);
  };

  const closeDialog = () => {
    setIsDialogOpen(false);
    setEditingAlert(null);
    setFormData(DEFAULT_FORM_DATA);
  };

  const handleSubmit = async () => {
    if (!formData.name.trim()) {
      setError('Name is required');
      return;
    }
    if (!formData.value.trim()) {
      setError('Value is required');
      return;
    }

    const parsedValue =
      formData.field === 'is_error' ? formData.value === 'true' : parseFloat(formData.value);

    if (formData.field !== 'is_error' && isNaN(parsedValue as number)) {
      setError('Value must be a valid number');
      return;
    }

    setIsSubmitting(true);
    setError(null);
    setSuccess(null);

    try {
      if (editingAlert) {
        await updateAlert({
          id: editingAlert._id,
          name: formData.name,
          field: formData.field,
          operator: formData.operator,
          value: parsedValue,
          severity: formData.severity,
        });
        setSuccess('Alert updated successfully');
      } else {
        await createAlert({
          name: formData.name,
          field: formData.field,
          operator: formData.operator,
          value: parsedValue,
          severity: formData.severity,
        });
        setSuccess('Alert created successfully');
      }
      closeDialog();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save alert');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleToggle = async (id: Id<'alerts'>) => {
    setTogglingId(id);
    setError(null);
    await toggleAlert({ id });
    setTogglingId(null);
  };

  const handleDelete = async (id: Id<'alerts'>) => {
    setDeletingId(id);
    setError(null);
    setSuccess(null);
    await deleteAlert({ id });
    setSuccess('Alert deleted successfully');
    setDeletingId(null);
  };

  const formatCondition = (alert: Alert) => {
    const fieldLabel = ALERT_FIELD_LABELS[alert.field as AlertField] ?? alert.field;
    const operatorLabel = ALERT_OPERATOR_LABELS[alert.operator as AlertOperator] ?? alert.operator;
    return `${fieldLabel} ${operatorLabel} ${alert.value}`;
  };

  const fieldOptions = ALERT_FIELDS.map((f) => ({
    value: f,
    label: ALERT_FIELD_LABELS[f],
  }));

  const operatorOptions = ALERT_OPERATORS.map((o) => ({
    value: o,
    label: ALERT_OPERATOR_LABELS[o],
  }));

  const severityOptions = ALERT_SEVERITIES.map((s) => ({
    value: s,
    label: s.charAt(0).toUpperCase() + s.slice(1),
  }));

  return (
    <div>
      <PageToolbar>
        <p className="text-sm text-muted-foreground">
          Configure alerts to highlight traces matching specific conditions
        </p>
        <div className="flex-1" />
        <button
          onClick={openCreateDialog}
          className="inline-flex items-center rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground shadow-sm transition-all hover:bg-primary/90 hover:shadow-md hover:shadow-primary/20 focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-2 focus:ring-offset-background"
        >
          New Alert
        </button>
      </PageToolbar>

      {success && (
        <div className="mb-4 rounded-xl border border-emerald-500/50 bg-emerald-500/10 p-4">
          <p className="text-sm text-emerald-400">{success}</p>
        </div>
      )}

      {alerts.length === 0 ? (
        <div className="card-elevated rounded-xl border border-border bg-card p-12 text-center">
          <p className="text-muted-foreground">No alerts configured</p>
          <p className="mt-1 text-sm text-muted-foreground/70">
            Create your first alert to start monitoring traces
          </p>
        </div>
      ) : (
        <div className="card-elevated overflow-hidden rounded-xl bg-card/40">
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-border">
              <thead className="bg-muted/30">
                <tr>
                  <th className="px-6 py-3.5 text-left text-xs font-medium uppercase tracking-wider text-muted-foreground">
                    Name
                  </th>
                  <th className="px-6 py-3.5 text-left text-xs font-medium uppercase tracking-wider text-muted-foreground">
                    Condition
                  </th>
                  <th className="px-6 py-3.5 text-left text-xs font-medium uppercase tracking-wider text-muted-foreground">
                    Severity
                  </th>
                  <th className="px-6 py-3.5 text-center text-xs font-medium uppercase tracking-wider text-muted-foreground">
                    Enabled
                  </th>
                  <th className="px-6 py-3.5 text-right text-xs font-medium uppercase tracking-wider text-muted-foreground">
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border bg-card">
                {alerts.map((alert: Alert) => (
                  <tr key={alert._id} className="table-row-interactive">
                    <td className="whitespace-nowrap px-6 py-4 text-sm font-medium text-foreground">
                      {alert.name}
                    </td>
                    <td className="whitespace-nowrap px-6 py-4 text-sm">
                      <code className="rounded bg-muted/50 px-1.5 py-0.5 font-mono text-xs">
                        {formatCondition(alert)}
                      </code>
                    </td>
                    <td className="whitespace-nowrap px-6 py-4">
                      <span
                        className={cn(
                          'inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium capitalize',
                          severityStyles[alert.severity as AlertSeverity],
                        )}
                      >
                        {alert.severity}
                      </span>
                    </td>
                    <td className="whitespace-nowrap px-6 py-4 text-center">
                      <Switch
                        checked={alert.enabled}
                        onCheckedChange={() => void handleToggle(alert._id)}
                        disabled={togglingId === alert._id}
                      />
                    </td>
                    <td className="whitespace-nowrap px-6 py-4 text-right text-sm">
                      <button
                        onClick={() => openEditDialog(alert)}
                        className="mr-3 font-medium text-primary transition-colors hover:text-primary/80"
                      >
                        Edit
                      </button>
                      <button
                        onClick={() => {
                          if (
                            confirm(
                              `Are you sure you want to delete "${alert.name}"?\n\nThis action cannot be undone.`,
                            )
                          ) {
                            void handleDelete(alert._id);
                          }
                        }}
                        disabled={deletingId === alert._id}
                        className="font-medium text-destructive transition-colors hover:text-destructive/80 disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        {deletingId === alert._id ? 'Deleting...' : 'Delete'}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="border-t border-border bg-muted/20 px-6 py-3">
            <p className="text-xs text-muted-foreground">
              Showing {alerts.length} {alerts.length === 1 ? 'alert' : 'alerts'}
            </p>
          </div>
        </div>
      )}

      <Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
        <DialogContent className="max-w-md p-6">
          <DialogHeader>
            <DialogTitle>{editingAlert ? 'Edit Alert' : 'Create Alert'}</DialogTitle>
            <DialogDescription>
              {editingAlert
                ? 'Modify the alert configuration below.'
                : 'Configure a new alert to monitor your traces.'}
            </DialogDescription>
          </DialogHeader>

          {error && (
            <div className="mt-4 rounded-lg border border-destructive/50 bg-destructive/10 p-3">
              <p className="text-sm text-destructive">{error}</p>
            </div>
          )}

          <div className={error ? 'mt-2 space-y-4' : 'mt-4 space-y-4'}>
            <div className="space-y-2">
              <label className="text-sm font-medium text-foreground">Name</label>
              <Input
                value={formData.name}
                onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                placeholder="e.g., Slow Response"
              />
            </div>

            <div className="space-y-2">
              <label className="text-sm font-medium text-foreground">Field</label>
              <Select
                value={formData.field}
                onChange={(v) => setFormData({ ...formData, field: v as AlertField })}
                options={fieldOptions}
              />
            </div>

            <div className="space-y-2">
              <label className="text-sm font-medium text-foreground">Operator</label>
              <Select
                value={formData.operator}
                onChange={(v) => setFormData({ ...formData, operator: v as AlertOperator })}
                options={operatorOptions}
              />
            </div>

            <div className="space-y-2">
              <label className="text-sm font-medium text-foreground">Value</label>
              {formData.field === 'is_error' ? (
                <Select
                  value={formData.value}
                  onChange={(v) => setFormData({ ...formData, value: v })}
                  options={[
                    { value: 'true', label: 'Yes (Error)' },
                    { value: 'false', label: 'No (Success)' },
                  ]}
                />
              ) : (
                <Input
                  type="number"
                  value={formData.value}
                  onChange={(e) => setFormData({ ...formData, value: e.target.value })}
                  placeholder="e.g., 5000"
                />
              )}
            </div>

            <div className="space-y-2">
              <label className="text-sm font-medium text-foreground">Severity</label>
              <Select
                value={formData.severity}
                onChange={(v) => setFormData({ ...formData, severity: v as AlertSeverity })}
                options={severityOptions}
              />
            </div>
          </div>

          <DialogFooter className="mt-6">
            <button
              type="button"
              onClick={closeDialog}
              className="rounded-lg border border-border bg-transparent px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-muted"
            >
              Cancel
            </button>
            <button
              onClick={() => void handleSubmit()}
              disabled={isSubmitting}
              className="inline-flex items-center rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground shadow-sm transition-all hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {isSubmitting ? (
                <>
                  <div className="mr-2 h-4 w-4 animate-spin rounded-full border-2 border-primary-foreground border-t-transparent" />
                  {editingAlert ? 'Saving...' : 'Creating...'}
                </>
              ) : editingAlert ? (
                'Save Changes'
              ) : (
                'Create Alert'
              )}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
