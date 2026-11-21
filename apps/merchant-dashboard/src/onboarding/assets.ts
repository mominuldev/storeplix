import flagBd from '../assets/onboarding/flag-bd.svg';
import eps from '../assets/onboarding/partner-eps.png';
import pathao from '../assets/onboarding/partner-pathao.png';
import redx from '../assets/onboarding/partner-redx.png';
import sslcommerz from '../assets/onboarding/partner-sslcommerz.png';
import steadfast from '../assets/onboarding/partner-steadfast.png';
import cottonPanjabi from '../assets/onboarding/preview-cotton-panjabi.png';
import jamdani from '../assets/onboarding/preview-jamdani-3piece.png';
import kidsKurti from '../assets/onboarding/preview-kids-kurti.png';
import silkSaree from '../assets/onboarding/preview-silk-saree.png';
import nusrat from '../assets/onboarding/testimonial-avatar-nusrat.png';

export const images = { flagBd, nusrat, silkSaree, jamdani, cottonPanjabi, kidsKurti };

// Figma trust row order: Steadfast, Pathao, RedX, bKash (text badge), SSLCommerz, EPS.
export const partners: { name: string; logo: string | null }[] = [
  { name: 'Steadfast', logo: steadfast },
  { name: 'Pathao', logo: pathao },
  { name: 'RedX', logo: redx },
  { name: 'bKash', logo: null },
  { name: 'SSLCommerz', logo: sslcommerz },
  { name: 'EPS', logo: eps },
];
