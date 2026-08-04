import "./globals.css";
export const metadata = { title: "PixelFlux" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
    return (
        <html lang="es">
            <body className="bg-light text-dark min-h-screen">{children}</body>
        </html>
    );
}