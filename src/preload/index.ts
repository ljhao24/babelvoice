import { contextBridge, ipcRenderer } from 'electron';
import {
  IPC,
  type AudioCapableApplication,
  type ClearCredentialsPayload,
  type Direction,
  type InstallVirtualOutputResult,
  type NativeAudioDevice,
  type NativeAudioDiagnostics,
  type NativeCapabilities,
  type NativePermissionSnapshot,
  type PlatformInfo,
  type ScreenPermissionRequestResult,
  type ScreenPermissionStatus,
  type SetCredentialsPayload,
  type StartTranslationParams,
  type TranslationEvent,
  type TranslationStatusPayload,
  type ValidateCredentialsPayload,
  type ValidateCredentialsResult,
  type VirtualOutputStatus
} from '../shared/ipc-types.js';
import type { UserPreferences } from '../shared/config-types.js';
import {
  METRICS_IPC,
  type MeetingMetricsSnapshot,
  type MeetingUsageLine
} from '../shared/meeting-metrics-types.js';
import type { CredentialStatus } from '../shared/engine-types.js';
import type { Locale } from '../shared/i18n-types.js';
import {
  MEETING_IPC,
  type AppendLinePayload,
  type ListMeetingsFilter,
  type LoadMeetingResult,
  type Meeting,
  type MeetingSummary,
  type OpenMeetingResult
} from '../shared/meeting-types.js';

type Unsub = () => void;

const onChannel = <T>(channel: string, cb: (payload: T) => void): Unsub => {
  const handler = (_evt: Electron.IpcRendererEvent, payload: T) => cb(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
};

const bridge = {
  onHotkeyPressed: (cb: (info: { accelerator: string; at: number }) => void) =>
    onChannel(IPC.HotkeyPressed, cb),

  /** Release the global hotkey while the capture modal records a new one. */
  setHotkeySuspended: (suspended: boolean): Promise<void> =>
    ipcRenderer.invoke(IPC.HotkeySetSuspended, suspended),

  onTranslationEvent: (cb: (event: TranslationEvent) => void) =>
    onChannel(IPC.TranslationEvent, cb),

  onTranslationStatus: (cb: (payload: TranslationStatusPayload) => void) =>
    onChannel(IPC.TranslationStatus, cb),

  getTranslationStatuses: (): Promise<TranslationStatusPayload[]> =>
    ipcRenderer.invoke(IPC.TranslationGetStatuses),

  startTranslation: (params: StartTranslationParams): Promise<true> =>
    ipcRenderer.invoke(IPC.TranslationStart, params),

  finishTranslation: (direction: Direction): Promise<boolean> =>
    ipcRenderer.invoke(IPC.TranslationFinish, direction),

  cancelTranslation: (direction: Direction): Promise<boolean> =>
    ipcRenderer.invoke(IPC.TranslationCancel, direction),

  platformInfo: (): Promise<PlatformInfo> => ipcRenderer.invoke(IPC.PlatformInfo),

  openSetupGuide: (): Promise<void> =>
    ipcRenderer.invoke(IPC.PlatformOpenSetupGuide),

  getScreenPermission: (): Promise<ScreenPermissionStatus> =>
    ipcRenderer.invoke(IPC.PlatformScreenPermission),

  requestScreenPermission: (): Promise<ScreenPermissionRequestResult> =>
    ipcRenderer.invoke(IPC.PlatformRequestScreenPermission),

  openScreenSettings: (): Promise<void> =>
    ipcRenderer.invoke(IPC.PlatformOpenScreenSettings),

  getVirtualOutputStatus: (): Promise<VirtualOutputStatus> =>
    ipcRenderer.invoke(IPC.AudioVirtualOutputStatus),

  requestVirtualOutputInstall: (): Promise<InstallVirtualOutputResult> =>
    ipcRenderer.invoke(IPC.AudioInstallVirtualOutput),

  nativeCapabilities: (): Promise<NativeCapabilities> =>
    ipcRenderer.invoke(IPC.NativeCapabilities),

  nativePermissions: (): Promise<NativePermissionSnapshot> =>
    ipcRenderer.invoke(IPC.NativePermissions),

  nativeAudioDevices: (): Promise<NativeAudioDevice[]> =>
    ipcRenderer.invoke(IPC.NativeAudioDevices),

  nativeAudioCapableApplications: (): Promise<AudioCapableApplication[]> =>
    ipcRenderer.invoke(IPC.NativeAudioCapableApplications),

  nativeAudioDiagnostics: (): Promise<NativeAudioDiagnostics> =>
    ipcRenderer.invoke(IPC.NativeAudioDiagnostics),

  toggleSubtitleOverlay: (): Promise<boolean> =>
    ipcRenderer.invoke(IPC.SubtitleToggle),

  getSubtitleOverlayVisible: (): Promise<boolean> =>
    ipcRenderer.invoke(IPC.SubtitleGetVisible),

  onSubtitleOverlayVisibility: (cb: (visible: boolean) => void) =>
    onChannel<boolean>(IPC.SubtitleVisibility, cb),

  notifySubtitleReady: (): Promise<boolean> =>
    ipcRenderer.invoke(IPC.SubtitleReady),

  getPreferences: (): Promise<UserPreferences> =>
    ipcRenderer.invoke(IPC.PreferencesGet),

  setPreferences: (
    partial: Partial<UserPreferences>
  ): Promise<UserPreferences> => ipcRenderer.invoke(IPC.PreferencesSet, partial),

  onPreferencesChanged: (cb: (prefs: UserPreferences) => void) =>
    onChannel<UserPreferences>(IPC.PreferencesChanged, cb),

  getCredentialStatus: (): Promise<CredentialStatus> =>
    ipcRenderer.invoke(IPC.CredentialsGet),

  setCredentials: (
    payload: SetCredentialsPayload
  ): Promise<CredentialStatus> =>
    ipcRenderer.invoke(IPC.CredentialsSet, payload),

  clearCredentials: (
    payload: ClearCredentialsPayload
  ): Promise<CredentialStatus> =>
    ipcRenderer.invoke(IPC.CredentialsClear, payload),

  validateCredentials: (
    payload: ValidateCredentialsPayload
  ): Promise<ValidateCredentialsResult> =>
    ipcRenderer.invoke(IPC.CredentialsValidate, payload),

  onCredentialsChanged: (cb: (status: CredentialStatus) => void) =>
    onChannel<CredentialStatus>(IPC.CredentialsChanged, cb),

  openMeeting: (params: {
    langSrc: string;
    langTgt: string;
  }): Promise<OpenMeetingResult> =>
    ipcRenderer.invoke(MEETING_IPC.Open, params),

  endMeeting: (): Promise<Meeting | null> =>
    ipcRenderer.invoke(MEETING_IPC.End),

  appendMeetingLine: (payload: AppendLinePayload): Promise<void> =>
    ipcRenderer.invoke(MEETING_IPC.AppendLine, payload),

  listMeetings: (
    filter?: ListMeetingsFilter
  ): Promise<MeetingSummary[]> =>
    ipcRenderer.invoke(MEETING_IPC.List, filter ?? {}),

  loadMeeting: (id: string): Promise<LoadMeetingResult | null> =>
    ipcRenderer.invoke(MEETING_IPC.Load, id),

  renameMeeting: (id: string, title: string): Promise<Meeting | null> =>
    ipcRenderer.invoke(MEETING_IPC.Rename, id, title),

  softDeleteMeeting: (id: string): Promise<void> =>
    ipcRenderer.invoke(MEETING_IPC.SoftDelete, id),

  getCurrentMeeting: (): Promise<Meeting | null> =>
    ipcRenderer.invoke(MEETING_IPC.Current),

  onMeetingAutoEnded: (cb: (meeting: Meeting) => void) =>
    onChannel<Meeting>(MEETING_IPC.AutoEnded, cb),

  // ---- Meeting monitor (link health, usage, cost) ----

  getMeetingMetrics: (): Promise<MeetingMetricsSnapshot | null> =>
    ipcRenderer.invoke(METRICS_IPC.Get),

  onMeetingMetrics: (cb: (snapshot: MeetingMetricsSnapshot | null) => void) =>
    onChannel<MeetingMetricsSnapshot | null>(METRICS_IPC.Changed, cb),

  getMeetingUsage: (meetingId: string): Promise<MeetingUsageLine[]> =>
    ipcRenderer.invoke(METRICS_IPC.Usage, meetingId),

  // ---- i18n ----

  getLocale: (): Promise<Locale> => ipcRenderer.invoke(IPC.I18nGetLocale),

  setLocale: (locale: Locale): Promise<Locale> =>
    ipcRenderer.invoke(IPC.I18nSetLocale, locale),

  onLocaleChanged: (cb: (locale: Locale) => void) =>
    onChannel<Locale>(IPC.I18nLocaleChanged, cb)
};

export type BabelVoiceBridge = typeof bridge;

contextBridge.exposeInMainWorld('babelVoiceBridge', bridge);
