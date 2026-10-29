import { ipcMain } from 'electron';
import { IPC } from '@shared/ipc-types.js';
import type {
  ClearCredentialsPayload,
  SetCredentialsPayload,
  ValidateCredentialsPayload,
  ValidateCredentialsResult
} from '@shared/ipc-types.js';
import type { CredentialStatus } from '@shared/engine-types.js';
import type { SessionOrchestrator } from '../sessions/session-orchestrator.js';
import {
  getCredentialStatus,
  setDoubaoCredentials,
  setQwenCredentials,
  setGeminiCredentials,
  setOpenAiCredentials
} from '../translation/credential-vault.js';
import { validateCredentials } from '../translation/connectivity-tester.js';
import { broadcastToAllRenderers } from '../window-manager.js';
import { t } from '../i18n.js';

export const registerCredentialsHandlers = (
  sessions: SessionOrchestrator
): void => {
  ipcMain.handle(IPC.CredentialsGet, (): CredentialStatus =>
    getCredentialStatus()
  );

  ipcMain.handle(
    IPC.CredentialsSet,
    (_evt, payload: SetCredentialsPayload): CredentialStatus => {
      // Engine-switch lock applies to credential edits too: the active engine
      // can be reconfigured mid-session (the running client already cached
      // its creds at start()), but flipping creds for a different engine and
      // then switching to it would still be guarded by PreferencesSet's lock.
      // Editing the active engine's creds doesn't affect an in-flight session.
      switch (payload.engineId) {
        case 'doubao': {
          const appKey = payload.appKey.trim();
          const accessKey = payload.accessKey.trim();
          if (!appKey || !accessKey) {
            throw new Error('doubao credentials require both appKey and accessKey');
          }
          setDoubaoCredentials({ appKey, accessKey });
          break;
        }
        case 'qwen': {
          const apiKey = payload.apiKey.trim();
          if (!apiKey) throw new Error('qwen credentials require apiKey');
          const workspaceId = payload.workspaceId?.trim() ?? '';
          // It becomes the leftmost DNS label of the endpoint host.
          if (workspaceId && !/^[a-z0-9-]+$/i.test(workspaceId)) {
            throw new Error(t('errors:invalidWorkspaceId'));
          }
          setQwenCredentials(workspaceId ? { apiKey, workspaceId } : { apiKey });
          break;
        }
        case 'gemini': {
          const apiKey = payload.apiKey.trim();
          if (!apiKey) throw new Error('gemini credentials require apiKey');
          setGeminiCredentials({ apiKey });
          break;
        }
        case 'openai': {
          const apiKey = payload.apiKey.trim();
          if (!apiKey) throw new Error('openai credentials require apiKey');
          setOpenAiCredentials({ apiKey });
          break;
        }
      }
      const status = getCredentialStatus();
      broadcastToAllRenderers(IPC.CredentialsChanged, status);
      return status;
    }
  );

  ipcMain.handle(
    IPC.CredentialsValidate,
    async (
      _evt,
      payload: ValidateCredentialsPayload
    ): Promise<ValidateCredentialsResult> => {
      // Block validation while a real session is running — connecting a
      // throwaway client at the same time as a live one would either trip
      // the provider's per-account concurrency cap or, worse, fight the
      // real session for the channel. The wizard never reaches this step
      // with an active session anyway (sidebar is hidden), but guard
      // against the "settings → reset wizard mid-meeting" edge case.
      if (sessions.hasActiveSessions()) {
        return {
          ok: false,
          message: t('errors:endMeetingFirst')
        };
      }
      return validateCredentials(payload.engineId);
    }
  );

  ipcMain.handle(
    IPC.CredentialsClear,
    (_evt, payload: ClearCredentialsPayload): CredentialStatus => {
      switch (payload.engineId) {
        case 'doubao':
          setDoubaoCredentials(null);
          break;
        case 'qwen':
          setQwenCredentials(null);
          break;
        case 'gemini':
          setGeminiCredentials(null);
          break;
        case 'openai':
          setOpenAiCredentials(null);
          break;
      }
      const status = getCredentialStatus();
      broadcastToAllRenderers(IPC.CredentialsChanged, status);
      return status;
    }
  );
};
