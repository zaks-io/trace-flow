import type { Doc, Id } from '@trace-flow/convex/_generated/dataModel';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { formatChannelDestination, type AlertFormData } from '@/lib/cost-alerts';
import {
  COST_ALERT_CONDITION_LABELS,
  COST_ALERT_SEVERITY_LABELS,
  COST_ALERT_WINDOW_LABELS,
} from '@/types/cost-alerts';
import { CostAlertSelectField } from './CostAlertSelectField';
import { buttonClass, secondaryButtonClass } from './costAlertDialogStyles';

interface CostAlertRuleDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  editingAlertId: Id<'costAlerts'> | null;
  alertForm: AlertFormData;
  setAlertForm: (form: AlertFormData) => void;
  apiKeys: Doc<'apiKeys'>[];
  channels: Doc<'costAlertChannels'>[];
  error: string | null;
  submitting: boolean;
  onSubmit: () => void;
}

function toggleListSelection(list: string[], id: string): string[] {
  return list.includes(id) ? list.filter((entry) => entry !== id) : [...list, id];
}

export function CostAlertRuleDialog({
  open,
  onOpenChange,
  editingAlertId,
  alertForm,
  setAlertForm,
  apiKeys,
  channels,
  error,
  submitting,
  onSubmit,
}: CostAlertRuleDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl p-6">
        <DialogHeader>
          <DialogTitle>{editingAlertId ? 'Edit Cost Alert' : 'Create Cost Alert'}</DialogTitle>
          <DialogDescription>
            Choose the cost condition, scope, delivery channels, and notification behavior.
          </DialogDescription>
        </DialogHeader>
        <div className="mt-4 grid gap-4 md:grid-cols-2">
          <div className="space-y-2">
            <label className="text-sm font-medium text-foreground">Name</label>
            <Input
              value={alertForm.name}
              onChange={(event) => setAlertForm({ ...alertForm, name: event.target.value })}
              placeholder="Production monthly budget"
            />
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium text-foreground">Severity</label>
            <CostAlertSelectField
              value={alertForm.severity}
              onChange={(value) =>
                setAlertForm({ ...alertForm, severity: value as AlertFormData['severity'] })
              }
              options={Object.entries(COST_ALERT_SEVERITY_LABELS).map(([value, label]) => ({
                value,
                label,
              }))}
            />
          </div>
          <div className="space-y-2 md:col-span-2">
            <label className="text-sm font-medium text-foreground">Condition</label>
            <CostAlertSelectField
              value={alertForm.conditionType}
              onChange={(value) =>
                setAlertForm({
                  ...alertForm,
                  conditionType: value as AlertFormData['conditionType'],
                })
              }
              options={Object.entries(COST_ALERT_CONDITION_LABELS).map(([value, label]) => ({
                value,
                label,
              }))}
            />
          </div>

          {(alertForm.conditionType === 'absolute_spend_threshold' ||
            alertForm.conditionType === 'single_request_cost_threshold') && (
            <>
              <div className="space-y-2">
                <label className="text-sm font-medium text-foreground">Time Window</label>
                <CostAlertSelectField
                  value={alertForm.window}
                  onChange={(value) =>
                    setAlertForm({ ...alertForm, window: value as AlertFormData['window'] })
                  }
                  options={Object.entries(COST_ALERT_WINDOW_LABELS).map(([value, label]) => ({
                    value,
                    label,
                  }))}
                />
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium text-foreground">
                  {alertForm.conditionType === 'single_request_cost_threshold'
                    ? 'Request Threshold (USD)'
                    : 'Threshold (USD)'}
                </label>
                <Input
                  type="number"
                  value={alertForm.thresholdUsd}
                  onChange={(event) =>
                    setAlertForm({ ...alertForm, thresholdUsd: event.target.value })
                  }
                  placeholder={
                    alertForm.conditionType === 'single_request_cost_threshold' ? '5' : '100'
                  }
                />
              </div>
            </>
          )}

          {alertForm.conditionType === 'projected_monthly_over' && (
            <div className="space-y-2 md:col-span-2">
              <label className="text-sm font-medium text-foreground">Budget (USD)</label>
              <Input
                type="number"
                value={alertForm.thresholdUsd}
                onChange={(event) =>
                  setAlertForm({ ...alertForm, thresholdUsd: event.target.value })
                }
                placeholder="1000"
              />
            </div>
          )}

          {alertForm.conditionType === 'hourly_spend_spike' && (
            <>
              <div className="space-y-2">
                <label className="text-sm font-medium text-foreground">Baseline Hours</label>
                <Input
                  type="number"
                  value={alertForm.baselineHours}
                  onChange={(event) =>
                    setAlertForm({ ...alertForm, baselineHours: event.target.value })
                  }
                  placeholder="24"
                />
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium text-foreground">Spike Multiplier</label>
                <Input
                  type="number"
                  value={alertForm.multiplier}
                  onChange={(event) =>
                    setAlertForm({ ...alertForm, multiplier: event.target.value })
                  }
                  placeholder="2"
                />
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium text-foreground">Minimum Hourly Spend</label>
                <Input
                  type="number"
                  value={alertForm.minCurrentHourUsd}
                  onChange={(event) =>
                    setAlertForm({ ...alertForm, minCurrentHourUsd: event.target.value })
                  }
                  placeholder="10"
                />
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium text-foreground">Minimum Increase</label>
                <Input
                  type="number"
                  value={alertForm.minIncreaseUsd}
                  onChange={(event) =>
                    setAlertForm({ ...alertForm, minIncreaseUsd: event.target.value })
                  }
                  placeholder="5"
                />
              </div>
            </>
          )}

          {alertForm.conditionType === 'model_approval_and_pricing' && (
            <>
              <div className="space-y-2">
                <label className="text-sm font-medium text-foreground">Time Window</label>
                <CostAlertSelectField
                  value={alertForm.window}
                  onChange={(value) =>
                    setAlertForm({ ...alertForm, window: value as AlertFormData['window'] })
                  }
                  options={Object.entries(COST_ALERT_WINDOW_LABELS).map(([value, label]) => ({
                    value,
                    label,
                  }))}
                />
              </div>
              <div className="space-y-2 md:col-span-2">
                <label className="text-sm font-medium text-foreground">
                  Approved Provider/Model Pairs
                </label>
                <textarea
                  value={alertForm.approvedModelsText}
                  onChange={(event) =>
                    setAlertForm({ ...alertForm, approvedModelsText: event.target.value })
                  }
                  rows={5}
                  className="w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-sm"
                  placeholder={'openai, gpt-4o\nanthropic, claude-sonnet-4'}
                />
              </div>
              <div className="space-y-2 md:col-span-2">
                <label className="text-sm font-medium text-foreground">
                  Allowed Zero-Cost Pairs
                </label>
                <textarea
                  value={alertForm.zeroCostModelsText}
                  onChange={(event) =>
                    setAlertForm({ ...alertForm, zeroCostModelsText: event.target.value })
                  }
                  rows={3}
                  className="w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-sm"
                  placeholder="openai, free-tier-model"
                />
              </div>
            </>
          )}

          <div className="space-y-2">
            <label className="text-sm font-medium text-foreground">Cooldown (minutes)</label>
            <Input
              type="number"
              value={alertForm.cooldownMinutes}
              onChange={(event) =>
                setAlertForm({ ...alertForm, cooldownMinutes: event.target.value })
              }
              placeholder="60"
            />
          </div>
          <div className="flex items-center justify-between rounded-lg border border-border px-3 py-2">
            <div>
              <p className="text-sm font-medium text-foreground">Notify on recovery</p>
              <p className="text-xs text-muted-foreground">
                Send a notification when the metric returns to normal.
              </p>
            </div>
            <Switch
              checked={alertForm.notifyOnRecovery}
              onCheckedChange={(checked) =>
                setAlertForm({ ...alertForm, notifyOnRecovery: checked })
              }
            />
          </div>

          <div className="space-y-2 md:col-span-2">
            <label className="text-sm font-medium text-foreground">Dimension Scope</label>
            <div className="grid gap-3 rounded-lg border border-border p-3 md:grid-cols-2">
              <div className="space-y-1">
                <label className="text-xs font-medium text-muted-foreground">Provider</label>
                <Input
                  value={alertForm.provider}
                  onChange={(event) => setAlertForm({ ...alertForm, provider: event.target.value })}
                  maxLength={200}
                  placeholder="openai"
                />
              </div>
              <div className="space-y-1">
                <label className="text-xs font-medium text-muted-foreground">Model</label>
                <Input
                  value={alertForm.model}
                  onChange={(event) => setAlertForm({ ...alertForm, model: event.target.value })}
                  maxLength={200}
                  placeholder="gpt-4o"
                />
              </div>
              <div className="space-y-1">
                <label className="text-xs font-medium text-muted-foreground">Operation</label>
                <Input
                  value={alertForm.baggageOperation}
                  onChange={(event) =>
                    setAlertForm({ ...alertForm, baggageOperation: event.target.value })
                  }
                  maxLength={200}
                  placeholder="checkout"
                />
              </div>
              <div className="space-y-1">
                <label className="text-xs font-medium text-muted-foreground">User ID</label>
                <Input
                  value={alertForm.baggageUserId}
                  onChange={(event) =>
                    setAlertForm({ ...alertForm, baggageUserId: event.target.value })
                  }
                  maxLength={200}
                  placeholder="user_123"
                />
              </div>
            </div>
          </div>

          <div className="space-y-2 md:col-span-2">
            <label className="text-sm font-medium text-foreground">API Key Scope</label>
            <div className="rounded-lg border border-border p-3">
              {apiKeys.length === 0 ? (
                <p className="text-sm text-muted-foreground">No API keys available yet.</p>
              ) : (
                <div className="space-y-2">
                  {apiKeys.map((apiKey) => {
                    const checked = alertForm.apiKeyIds.includes(String(apiKey._id));
                    return (
                      <label key={apiKey._id} className="flex items-center gap-2 text-sm">
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() =>
                            setAlertForm({
                              ...alertForm,
                              apiKeyIds: toggleListSelection(
                                alertForm.apiKeyIds,
                                String(apiKey._id),
                              ),
                            })
                          }
                        />
                        <span>{apiKey.name ?? apiKey.key}</span>
                      </label>
                    );
                  })}
                  <p className="text-xs text-muted-foreground">
                    Leave all unchecked to alert across every API key in the organization.
                  </p>
                </div>
              )}
            </div>
          </div>

          <div className="space-y-2 md:col-span-2">
            <label className="text-sm font-medium text-foreground">Delivery Channels</label>
            <div className="rounded-lg border border-border p-3">
              {channels.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  Create a channel first so this alert has somewhere to deliver.
                </p>
              ) : (
                <div className="space-y-2">
                  {channels.map((channel) => {
                    const checked = alertForm.channelIds.includes(String(channel._id));
                    return (
                      <label key={channel._id} className="flex items-center gap-2 text-sm">
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() =>
                            setAlertForm({
                              ...alertForm,
                              channelIds: toggleListSelection(
                                alertForm.channelIds,
                                String(channel._id),
                              ),
                            })
                          }
                        />
                        <span>{channel.name}</span>
                        <span className="text-xs text-muted-foreground">
                          {formatChannelDestination(channel)}
                        </span>
                      </label>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        </div>
        {error && (
          <div className="mt-4 rounded-lg border border-destructive/50 bg-destructive/10 p-3">
            <p className="text-sm text-destructive">{error}</p>
          </div>
        )}
        <DialogFooter className="mt-6">
          <button className={secondaryButtonClass} onClick={() => onOpenChange(false)}>
            Cancel
          </button>
          <button className={buttonClass} disabled={submitting} onClick={onSubmit}>
            {submitting ? 'Saving...' : editingAlertId ? 'Save Alert' : 'Create Alert'}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
