import './globals.css'

export const metadata = {
  title: 'Kujira Tax Exporter | Awaken Tax',
  description: 'Export your Kujira transactions in Awaken Tax CSV format',
}

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}