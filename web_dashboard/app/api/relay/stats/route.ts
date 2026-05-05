import { NextResponse } from "next/server";
import { relayRegistrar } from "@/lib/services/RelayRegistrar";

export async function GET() {
  return NextResponse.json(relayRegistrar.getStats());
}
