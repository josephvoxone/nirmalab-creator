import type { Catalog } from './catalog.js';

const opt = (id: string, label: string, prompt = label.toLowerCase()) => ({ id, label, prompt });
export const look = (l: Record<string, string>) => ({ style: 'storybook', genre: 'auto', era: 'auto', camera: 'auto', lens: 'auto', aperture: 'auto', palette: 'auto', lighting: 'auto', tempo: 'mengalir', ...l });
export const CATALOG: Catalog = {
  templates: [
    { id: 'drama-hewan', name: 'Drama Hewan', tagline: 'Kisah sedih hewan', mode: 'konsisten', aspect: '9:16', narrator: 'n', example: 'Seekor kucing oranye ditinggal pemiliknya pindah rumah dan menunggu setiap sore.', look: look({ genre: 'drama', palette: 'senja' }) },
    { id: 'dongeng-anak', name: 'Dongeng Tidur', tagline: 'Pengantar tidur', mode: 'konsisten', aspect: '9:16', narrator: 'n', example: 'Bintang kecil bernama Kerlip takut gelap sampai bulan mengajaknya berkeliling.', look: look({ genre: 'dongeng', palette: 'pastel', tempo: 'tenang' }) },
    { id: 'fakta-faceless', name: 'Fakta Unik', tagline: 'Faceless edukasi', mode: 'cepat', aspect: '9:16', narrator: 'n', example: 'Lima fakta mengejutkan tentang gurita yang jarang diketahui orang banyak.', look: look({ style: 'documentary', tempo: 'dinamis' }) }
  ],
  styles: [opt('storybook', 'Storybook cat air'), opt('pixar-3d', 'Animasi 3D'), opt('documentary', 'Dokumenter')],
  genres: [opt('auto', 'Umum', ''), opt('drama', 'Drama'), opt('dongeng', 'Dongeng')],
  eras: [opt('auto', 'Auto', ''), opt('1980s', '1980-an')],
  tempos: [{ ...opt('tenang', 'Tenang', ''), shots: 6 }, { ...opt('mengalir', 'Mengalir', ''), shots: 8 }, { ...opt('dinamis', 'Dinamis', ''), shots: 10 }],
  cameras: [opt('auto', 'Auto', ''), opt('film35', '35mm Film')],
  lenses: [opt('auto', 'Auto', ''), opt('halation', 'Halation vintage')],
  apertures: [opt('auto', 'Auto', ''), opt('f14', 'f/1.4 terbuka')],
  palettes: [
    { ...opt('auto', 'Auto', ''), swatches: [] },
    { ...opt('senja', 'Senja Dongeng'), swatches: ['#2e2a4f', '#6b4f8c', '#d9779b', '#f2a65a', '#f7d488', '#1b1b2f'] },
    { ...opt('pastel', 'Pastel Kapas'), swatches: ['#fde2e4', '#fad2e1', '#e2ece9', '#bee1e6', '#f0efeb', '#dfe7fd'] },
    { ...opt('noir', 'Noir Monokrom'), swatches: ['#000000', '#1a1a1a', '#4d4d4d', '#8c8c8c', '#cfcfcf', '#ffffff'] }
  ],
  lighting: [opt('auto', 'Auto', ''), opt('golden-hour', 'Golden hour')],
  framings: [opt('medium', 'Medium', 'Medium shot'), opt('close-up', 'Close-up', 'Close-up'), opt('wide', 'Wide', 'Wide shot')],
  moves: [opt('static', 'Static', 'the camera stays still'), opt('push-in', 'Push in', 'the camera pushes in slowly')]
};

