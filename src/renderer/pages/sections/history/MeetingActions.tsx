import { useEffect, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { EllipsisIcon, PencilIcon, Trash2Icon } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu';
import { Field, FieldError, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';

interface MeetingRef {
  id: string;
  title: string;
  lineCount: number;
}

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * A finished meeting's "…" menu: 重命名… and 删除…, each confirmed in its own
 * dialog. The open meeting has no menu — it is managed on the 会议 page.
 */
export function MeetingActionsMenu({
  meeting,
  onRenamed,
  onDeleted,
  className
}: {
  meeting: MeetingRef;
  onRenamed: (title: string) => void;
  onDeleted: () => void;
  className?: string;
}): React.JSX.Element {
  const { t } = useTranslation('transcript');
  const [dialog, setDialog] = useState<'rename' | 'delete' | null>(null);
  const close = (open: boolean): void => {
    if (!open) setDialog(null);
  };

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              variant="ghost"
              size="icon-sm"
              className={className}
              aria-label={t('actions.more', { title: meeting.title })}
            />
          }
        >
          <EllipsisIcon />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuGroup>
            <DropdownMenuItem onClick={() => setDialog('rename')}>
              <PencilIcon />
              {t('actions.rename')}
            </DropdownMenuItem>
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          <DropdownMenuGroup>
            <DropdownMenuItem variant="destructive" onClick={() => setDialog('delete')}>
              <Trash2Icon />
              {t('actions.delete')}
            </DropdownMenuItem>
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>
      <RenameMeetingDialog
        meeting={meeting}
        open={dialog === 'rename'}
        onOpenChange={close}
        onRenamed={onRenamed}
      />
      <DeleteMeetingDialog
        meeting={meeting}
        open={dialog === 'delete'}
        onOpenChange={close}
        onDeleted={onDeleted}
      />
    </>
  );
}

/** Enter saves; 保存 is enabled only for a new, non-empty title. */
function RenameMeetingDialog({
  meeting,
  open,
  onOpenChange,
  onRenamed
}: {
  meeting: MeetingRef;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onRenamed: (title: string) => void;
}): React.JSX.Element {
  const { t } = useTranslation('transcript');
  const { t: tc } = useTranslation('common');
  const inputId = useId();
  const [draft, setDraft] = useState(meeting.title);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setDraft(meeting.title);
    setError(null);
  }, [open, meeting.title]);

  const next = draft.trim();
  const canSave = next.length > 0 && next !== meeting.title && !saving;

  const save = async (): Promise<void> => {
    if (!canSave) return;
    setSaving(true);
    setError(null);
    try {
      const updated = await window.babelVoiceBridge.renameMeeting(meeting.id, next);
      if (!updated) throw new Error(t('actions.gone'));
      onRenamed(updated.title);
      onOpenChange(false);
    } catch (err) {
      setError(t('actions.renameFailed', { message: errorText(err) }));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent showCloseButton={false}>
        <form
          className="contents"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <DialogHeader>
            <DialogTitle>{t('actions.renameTitle')}</DialogTitle>
          </DialogHeader>
          <Field data-invalid={error ? true : undefined}>
            <FieldLabel htmlFor={inputId}>{t('actions.titleLabel')}</FieldLabel>
            <Input
              id={inputId}
              value={draft}
              aria-invalid={error ? true : undefined}
              onFocus={(e) => e.currentTarget.select()}
              onChange={(e) => setDraft(e.target.value)}
            />
            {error && <FieldError>{error}</FieldError>}
          </Field>
          <DialogFooter>
            <DialogClose render={<Button type="button" variant="outline" />}>{tc('cancel')}</DialogClose>
            <Button type="submit" disabled={!canSave}>
              {tc('save')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Says what goes with the meeting; default focus is 取消. */
function DeleteMeetingDialog({
  meeting,
  open,
  onOpenChange,
  onDeleted
}: {
  meeting: MeetingRef;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDeleted: () => void;
}): React.JSX.Element {
  const { t } = useTranslation('transcript');
  const { t: tc } = useTranslation('common');
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) setError(null);
  }, [open]);

  const remove = async (): Promise<void> => {
    setDeleting(true);
    setError(null);
    try {
      await window.babelVoiceBridge.softDeleteMeeting(meeting.id);
      onOpenChange(false);
      onDeleted();
    } catch (err) {
      setError(t('actions.deleteFailed', { message: errorText(err) }));
    } finally {
      setDeleting(false);
    }
  };

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t('actions.deleteTitle', { title: meeting.title })}</AlertDialogTitle>
          <AlertDialogDescription>
            {t('actions.deleteDescription', { count: meeting.lineCount })}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel>{tc('cancel')}</AlertDialogCancel>
          <AlertDialogAction variant="destructive" disabled={deleting} onClick={() => void remove()}>
            {t('actions.deleteConfirm')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
