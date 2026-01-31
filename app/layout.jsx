import './globals.css'

export const metadata = {
  title: 'Injective Tax Exporter | Awaken Tax',
  description: 'Export your Injective transactions in Awaken Tax CSV format',
}

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}