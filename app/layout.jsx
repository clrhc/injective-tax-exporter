import './globals.css'
import config from '../chain.config'

export const metadata = {
  title: `${config.name} Tax Exporter | Awaken Tax`,
  description: `Export your ${config.name} transactions in Awaken Tax CSV format`,
}

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}
