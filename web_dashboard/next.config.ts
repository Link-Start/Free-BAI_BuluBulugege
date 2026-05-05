import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  async rewrites() {
    return [
      {
        source: "/v1beta/:path*",
        destination: "/api/v1beta/:path*",
      },
    ];
  },
};

export default nextConfig;
