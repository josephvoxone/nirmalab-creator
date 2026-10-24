import { useLocation, useNavigate, useParams, type Location } from 'react-router-dom';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import SettingsPage, { type SettingsTab } from './SettingsPage.js';

/** ChatGPT-style settings: a modal over whatever page you were on, one URL per tab. */
export default function SettingsDialog() {
  const { tab = 'umum' } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const background = (location.state as { background?: Location } | null)?.background;
  const close = () => navigate(background ? `${background.pathname}${background.search}` : '/', { replace: !background });
  return (
    <Dialog open onOpenChange={open => { if (!open) close(); }}>
      <DialogContent initialFocus={false} className="flex h-[min(680px,88vh)] flex-col gap-0 overflow-hidden p-0 sm:max-w-[820px]">
        <div className="flex h-12 shrink-0 items-center border-b px-4">
          <DialogTitle className="text-[15px]">Pengaturan</DialogTitle>
        </div>
        <SettingsPage tab={tab as SettingsTab} onTab={t => navigate(`/pengaturan/${t}`, { replace: true, state: { background } })} />
      </DialogContent>
    </Dialog>
  );
}
