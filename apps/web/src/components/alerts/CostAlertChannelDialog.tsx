import type { Id } from '@trace-flow/convex/_generated/dataModel';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import type { ChannelFormData } from '@/lib/cost-alerts';
import { CostAlertSelectField } from './CostAlertSelectField';
import { buttonClass, secondaryButtonClass } from './costAlertDialogStyles';

interface CostAlertChannelDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  editingChannelId: Id<'costAlertChannels'> | null;
  channelForm: ChannelFormData;
  setChannelForm: (form: ChannelFormData) => void;
  error: string | null;
  submitting: boolean;
  onSubmit: () => void;
}

export function CostAlertChannelDialog({
  open,
  onOpenChange,
  editingChannelId,
  channelForm,
  setChannelForm,
  error,
  submitting,
  onSubmit,
}: CostAlertChannelDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg p-6">
        <DialogHeader>
          <DialogTitle>{editingChannelId ? 'Edit Channel' : 'Create Channel'}</DialogTitle>
          <DialogDescription>
            Configure email recipients or a webhook endpoint for cost alerts.
          </DialogDescription>
        </DialogHeader>
        <div className="mt-4 space-y-4">
          <div className="space-y-2">
            <label className="text-sm font-medium text-foreground">Name</label>
            <Input
              value={channelForm.name}
              onChange={(event) => setChannelForm({ ...channelForm, name: event.target.value })}
              placeholder="Ops email"
            />
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium text-foreground">Type</label>
            <CostAlertSelectField
              value={channelForm.type}
              onChange={(value) =>
                setChannelForm({
                  ...channelForm,
                  type: value as ChannelFormData['type'],
                })
              }
              options={[
                { value: 'email', label: 'Email' },
                { value: 'webhook', label: 'Webhook' },
              ]}
            />
          </div>

          {channelForm.type === 'email' ? (
            <div className="space-y-2">
              <label className="text-sm font-medium text-foreground">Recipients</label>
              <Input
                value={channelForm.recipientsText}
                onChange={(event) =>
                  setChannelForm({ ...channelForm, recipientsText: event.target.value })
                }
                placeholder="ops@example.com, finance@example.com"
              />
              <p className="text-xs text-muted-foreground">
                Separate multiple email addresses with commas or new lines.
              </p>
            </div>
          ) : (
            <>
              <div className="space-y-2">
                <label className="text-sm font-medium text-foreground">Webhook URL</label>
                <Input
                  value={channelForm.webhookUrl}
                  onChange={(event) =>
                    setChannelForm({ ...channelForm, webhookUrl: event.target.value })
                  }
                  placeholder="https://example.com/webhooks/trace-flow"
                />
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium text-foreground">Signing Secret</label>
                <Input
                  value={channelForm.webhookSecret}
                  onChange={(event) =>
                    setChannelForm({ ...channelForm, webhookSecret: event.target.value })
                  }
                  placeholder="Optional secret for X-Trace-Flow-Signature"
                />
              </div>
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <label className="text-sm font-medium text-foreground">Custom Headers</label>
                  <button
                    type="button"
                    className="text-sm text-primary"
                    onClick={() =>
                      setChannelForm({
                        ...channelForm,
                        webhookHeaders: [...channelForm.webhookHeaders, { key: '', value: '' }],
                      })
                    }
                  >
                    Add Header
                  </button>
                </div>
                {channelForm.webhookHeaders.length === 0 ? (
                  <p className="text-xs text-muted-foreground">No custom headers configured.</p>
                ) : (
                  <div className="space-y-2">
                    {channelForm.webhookHeaders.map((header, index) => (
                      <div key={`${index}-${header.key}`} className="grid grid-cols-2 gap-2">
                        <Input
                          value={header.key}
                          onChange={(event) =>
                            setChannelForm({
                              ...channelForm,
                              webhookHeaders: channelForm.webhookHeaders.map((entry, entryIndex) =>
                                entryIndex === index
                                  ? { ...entry, key: event.target.value }
                                  : entry,
                              ),
                            })
                          }
                          placeholder="Header name"
                        />
                        <div className="flex gap-2">
                          <Input
                            value={header.value}
                            onChange={(event) =>
                              setChannelForm({
                                ...channelForm,
                                webhookHeaders: channelForm.webhookHeaders.map(
                                  (entry, entryIndex) =>
                                    entryIndex === index
                                      ? { ...entry, value: event.target.value }
                                      : entry,
                                ),
                              })
                            }
                            placeholder="Header value"
                          />
                          <button
                            type="button"
                            className="text-sm text-destructive"
                            onClick={() =>
                              setChannelForm({
                                ...channelForm,
                                webhookHeaders: channelForm.webhookHeaders.filter(
                                  (_entry, entryIndex) => entryIndex !== index,
                                ),
                              })
                            }
                          >
                            Remove
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </>
          )}
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
            {submitting ? 'Saving...' : editingChannelId ? 'Save Channel' : 'Create Channel'}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
