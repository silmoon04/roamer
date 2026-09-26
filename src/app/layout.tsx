import type { Metadata } from 'next';
import './fonts.css';
import './globals.css';
export const metadata:Metadata={title:'Roamer · A few days away',description:'Talk through a trip. Compare places, flights and stays as the research comes in.',robots:{index:false,follow:false}};
export default function RootLayout({children}:{children:React.ReactNode}) {
  return <html lang="en-GB"><body>{children}</body></html>;
}
