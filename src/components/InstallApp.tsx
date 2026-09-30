import React, { useEffect, useState } from 'react';
import { Download, Share, SquarePlus, Smartphone } from 'lucide-react';
import { canPromptInstall, iosVersion, isIOS, isStandalone, onInstallStateChange, promptInstall } from '../lib/pwa';
import { Button, Modal, Notice } from './ui';

export function useInstallAvailable() {
  const [can, setCan] = useState(canPromptInstall());
  useEffect(() => { const off = onInstallStateChange(() => setCan(canPromptInstall())); return () => { off(); }; }, []);
  return can;
}

/** iPhone / iPad Home Screen steps (Safari; iOS/iPadOS 16.4+ also allows other browsers' Share menu). */
export function IosInstallSteps() {
  const v = iosVersion();
  return (
    <div className="space-y-3 text-sm text-slate-700">
      <ol className="space-y-2 list-decimal ml-5">
        <li>Open Qonnect in <b>Safari</b>. On iOS/iPadOS 16.4 or later you can also use Chrome or Edge.</li>
        <li>Tap the <b>Share</b> button <Share className="inline w-4 h-4 -mt-0.5" />. On iPhone it's at the bottom of the screen; on iPad it's at the top right, next to the address bar.</li>
        <li>Scroll down and tap <b>Add to Home Screen</b> <SquarePlus className="inline w-4 h-4 -mt-0.5" />. If you don't see it, tap <b>Edit Actions…</b> and add it.</li>
        <li>Keep the name <b>Qonnect</b> and tap <b>Add</b>.</li>
        <li>Open Qonnect from the new Home Screen icon and sign in.</li>
      </ol>
      <Notice tone="sky">
        Push notifications on iPhone and iPad need <b>iOS / iPadOS 16.4 or later</b>, and only work when Qonnect is opened from the Home Screen icon.
        {v !== null && v < 16.4 && <> This device reports iOS {Math.floor(v)}, so push notifications aren't available — you can still use the in-app notification list.</>}
      </Notice>
    </div>
  );
}

export function InstallAppDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const can = useInstallAvailable();
  const [result, setResult] = useState<string | null>(null);
  const standalone = isStandalone();
  const ios = isIOS();
  return (
    <Modal open={open} onClose={onClose} title="Install Qonnect" subtitle="Add Qonnect to your device like an app">
      {standalone ? (
        <Notice tone="emerald">Qonnect is already installed and running as an app on this device.</Notice>
      ) : can ? (
        <div className="space-y-3 text-sm text-slate-700">
          <p>Install Qonnect for quick access from your home screen, taskbar or dock. It opens in its own window and still needs your normal sign-in.</p>
          <Button variant="primary" onClick={async () => { const r = await promptInstall(); setResult(r === 'accepted' ? 'Installed — you can open Qonnect from your home screen or app list.' : 'Installation was cancelled.'); }}>
            <Download className="w-4 h-4" />Install app
          </Button>
          {result && <Notice tone="sky">{result}</Notice>}
        </div>
      ) : ios ? (
        <IosInstallSteps />
      ) : (
        <div className="space-y-3 text-sm text-slate-700">
          <Notice tone="sky">This browser isn't offering installation right now. You can keep using Qonnect in the browser; everything works the same.</Notice>
          <ul className="list-disc ml-5 space-y-1">
            <li><b>Chrome / Edge (Windows, Mac, Android):</b> use the install icon <Smartphone className="inline w-4 h-4 -mt-0.5" /> in the address bar, or the browser menu → <i>Install Qonnect</i> / <i>Add to Home screen</i>.</li>
            <li><b>Samsung Internet:</b> menu → <i>Add page to</i> → <i>Home screen</i>.</li>
            <li><b>Firefox (desktop):</b> installing web apps isn't supported. Bookmark the page instead.</li>
            <li>If you already installed Qonnect, open it from your apps list.</li>
          </ul>
        </div>
      )}
    </Modal>
  );
}
