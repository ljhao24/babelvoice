/**
 * Dev-only gallery of the shadcn components in direction A. Open
 * http://localhost:5180/dev/ui-gallery.html under `npm run dev:web`; it is not
 * an Electron entry and never ships.
 *
 * Besides the look, it exercises the Esc / focus wiring: a fake running
 * session that bare Esc stops (as `useGlobalHotkey` does), a Select inside a
 * new Dialog, and a Select inside a legacy <Modal>.
 */
import { useEffect, useState } from 'react';
import ReactDOM from 'react-dom/client';
import { CaptionsIcon, MicIcon, Settings2Icon, SquareIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select';
import { Slider } from '@/components/ui/slider';
import { Switch } from '@/components/ui/switch';
import { Modal } from '@/components/ui/Modal';
import { initRendererI18n } from '@/i18n/index';
import { hasEscapeLayer } from '@/lib/escape-stack';

const LAYOUTS = [
  { label: '时间线（推荐）', value: 'timeline' },
  { label: '左右并排', value: 'split' }
];

const BACKGROUNDS = [
  { label: '玻璃磨砂', value: 'glass' },
  { label: '纯色面板', value: 'solid' },
  { label: '完全透明（仅文字）', value: 'transparent' }
];

const LIVE_LINES = [1, 2, 3].map((n) => ({ label: `${n} 行`, value: n }));

function Section({
  title,
  children
}: {
  title: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <section className="flex flex-col gap-2">
      <h2 className="px-1 text-callout font-semibold text-muted-foreground">{title}</h2>
      {children}
    </section>
  );
}

/** One row of a Mac grouped list: label and hint leading, control trailing. */
function Row({
  label,
  hint,
  children
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="flex items-center gap-4 border-t border-border px-3.5 py-2.5 first:border-t-0">
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-body">{label}</span>
        {hint && <span className="text-callout text-muted-foreground">{hint}</span>}
      </div>
      {children}
    </div>
  );
}

function Group({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <div className="rounded-xl border border-border bg-card">{children}</div>;
}

function LanguageSelect({ size }: { size?: 'sm' | 'default' }): React.JSX.Element {
  const items = [
    { label: '中文', value: 'zh' },
    { label: 'English', value: 'en' },
    { label: '日本語', value: 'ja' }
  ];
  return (
    <Select items={items} defaultValue="en">
      <SelectTrigger size={size} className="min-w-32">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectGroup>
          {items.map((item) => (
            <SelectItem key={item.value} value={item.value}>
              {item.label}
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  );
}

function Gallery(): React.JSX.Element {
  const [dark, setDark] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [stoppedByEsc, setStoppedByEsc] = useState(0);
  const [opacity, setOpacity] = useState(80);
  const [fontSize, setFontSize] = useState(28);
  const [legacyOpen, setLegacyOpen] = useState(false);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
  }, [dark]);

  // Same rule as useGlobalHotkey: bare Esc stops the session unless a layer
  // (dialog, open menu) has taken it.
  useEffect(() => {
    if (!speaking) return;
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !hasEscapeLayer()) {
        setSpeaking(false);
        setStoppedByEsc((n) => n + 1);
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [speaking]);

  return (
    <div className="fixed inset-0 overflow-y-auto bg-background font-sans text-body text-foreground select-text">
      <div className="mx-auto flex max-w-[760px] flex-col gap-6 px-6 py-8">
        <header className="flex flex-wrap items-center gap-3">
          <div className="flex flex-col">
            <h1 className="font-heading text-title2 font-semibold">组件预览</h1>
            <span className="text-callout text-muted-foreground">方向 A · 原生 Mac</span>
          </div>
          <label className="ml-auto flex items-center gap-2">
            <span>深色</span>
            <Switch checked={dark} onCheckedChange={setDark} />
          </label>
        </header>

        <Section title="按钮">
          <Group>
            <div className="flex flex-wrap items-center gap-2 p-3.5">
              <Button>
                <MicIcon data-icon="inline-start" />
                开始翻译
              </Button>
              <Button variant="outline">
                <CaptionsIcon data-icon="inline-start" />
                显示字幕浮窗
              </Button>
              <Button variant="secondary">测试翻译</Button>
              <Button variant="ghost">取消</Button>
              <Button variant="destructive">结束会议</Button>
              <Button variant="link">前往设置</Button>
            </div>
            <div className="flex flex-wrap items-center gap-2 border-t border-border p-3.5">
              <Button size="xs" variant="outline">
                xs
              </Button>
              <Button size="sm" variant="outline">
                sm
              </Button>
              <Button variant="outline">default</Button>
              <Button size="lg" variant="outline">
                lg
              </Button>
              <Button size="icon-sm" variant="ghost" aria-label="设置">
                <Settings2Icon />
              </Button>
              <Button size="icon" variant="outline" aria-label="停止">
                <SquareIcon />
              </Button>
              <Button disabled>不可用</Button>
            </div>
          </Group>
        </Section>

        <Section title="字幕样式（分组设置）">
          <Group>
            <Row label="双向字幕布局" hint="你说和对方说同时开启时的排列方式。">
              <Select items={LAYOUTS} defaultValue="timeline">
                <SelectTrigger className="min-w-36">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {LAYOUTS.map((item) => (
                      <SelectItem key={item.value} value={item.value}>
                        {item.label}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </Row>
            <Row label="背景样式" hint="投屏分享时建议用「玻璃磨砂」。">
              <Select items={BACKGROUNDS} defaultValue="glass">
                <SelectTrigger className="min-w-36">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {BACKGROUNDS.map((item) => (
                      <SelectItem key={item.value} value={item.value}>
                        {item.label}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </Row>
            <Row label="背景透明度">
              <div className="flex w-56 items-center gap-3">
                <Slider
                  value={opacity}
                  onValueChange={(v) => setOpacity(v as number)}
                  aria-label="背景透明度"
                />
                <span className="w-12 text-right whitespace-nowrap text-muted-foreground tabular-nums">
                  {opacity}%
                </span>
              </div>
            </Row>
            <Row label="译文字号" hint="推荐 24 – 32 px。">
              <div className="flex w-56 items-center gap-3">
                <Slider
                  value={fontSize}
                  min={16}
                  max={48}
                  onValueChange={(v) => setFontSize(v as number)}
                  aria-label="译文字号"
                />
                <span className="w-12 text-right whitespace-nowrap text-muted-foreground tabular-nums">
                  {fontSize} px
                </span>
              </div>
            </Row>
            <Row label="实时字幕行数" hint="正在说的句子最多占几行。">
              <Select items={LIVE_LINES} defaultValue={2}>
                <SelectTrigger size="sm" className="min-w-20">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {LIVE_LINES.map((item) => (
                      <SelectItem key={item.value} value={item.value}>
                        {item.label}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </Row>
            <Row label="显示原文" hint="关闭后只看译文，长会议更好扫读。">
              <Switch defaultChecked aria-label="显示原文" />
            </Row>
            <Row label="保留历史字幕">
              <Switch defaultChecked size="sm" aria-label="保留历史字幕" />
            </Row>
          </Group>
        </Section>

        <Section title="对话框与 Esc">
          <Group>
            <Row
              label="模拟翻译进行中"
              hint={
                stoppedByEsc > 0
                  ? `直接按 Esc 会停止翻译（已停止 ${stoppedByEsc} 次）。菜单或对话框打开时按 Esc 不应停止。`
                  : '开启后，直接按 Esc 会停止翻译；菜单或对话框打开时按 Esc 只关闭它们。'
              }
            >
              <Switch checked={speaking} onCheckedChange={setSpeaking} aria-label="模拟翻译进行中" />
            </Row>
            <Row label="新 Dialog" hint="里面放了一个 Select：先关菜单，再关对话框。">
              <Dialog>
                <DialogTrigger render={<Button variant="outline" />}>结束会议…</DialogTrigger>
                <DialogContent>
                  <DialogHeader>
                    <DialogTitle>结束会议？</DialogTitle>
                    <DialogDescription>结束后本场对话会保存到「历史」。</DialogDescription>
                  </DialogHeader>
                  <div className="flex items-center justify-between gap-4">
                    <span>对方语言</span>
                    <LanguageSelect />
                  </div>
                  <DialogFooter>
                    <DialogClose render={<Button variant="outline" />}>取消</DialogClose>
                    <DialogClose render={<Button variant="destructive" />}>结束会议</DialogClose>
                  </DialogFooter>
                </DialogContent>
              </Dialog>
            </Row>
            <Row label="旧 Modal 里的新 Select" hint="迁移过渡期：菜单要显示在旧弹窗上方，焦点不被抢回。">
              <Button variant="outline" onClick={() => setLegacyOpen(true)}>
                打开旧 Modal
              </Button>
            </Row>
          </Group>
        </Section>
      </div>

      <Modal
        open={legacyOpen}
        onClose={() => setLegacyOpen(false)}
        label="旧 Modal"
        width={420}
        panelStyle={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 16 }}
      >
        <span>旧 Modal（legacy）里的新 Select</span>
        <LanguageSelect size="sm" />
        <Button variant="outline" onClick={() => setLegacyOpen(false)}>
          关闭
        </Button>
      </Modal>
    </div>
  );
}

void initRendererI18n().then(() => {
  ReactDOM.createRoot(document.getElementById('root')!).render(<Gallery />);
});
