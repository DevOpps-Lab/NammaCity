import { NextResponse } from "next/server";

// This is a foundational stub for the WhatsApp integration webhook (e.g., using Twilio).
// You can point your Twilio Sandbox webhook to: https://<your-domain>/api/whatsapp/inbound

export async function POST(req: Request) {
  try {
    // Twilio sends data as x-www-form-urlencoded
    const bodyText = await req.text();
    const params = new URLSearchParams(bodyText);

    const fromNumber = params.get("From"); // e.g., "whatsapp:+14155238886"
    const body = params.get("Body"); // Optional text message
    
    // Extract Media (Photo of the defect)
    const mediaUrl = params.get("MediaUrl0");
    
    // Extract Location (Twilio sends lat/long if the user shares a location pin)
    const latitude = params.get("Latitude");
    const longitude = params.get("Longitude");

    console.log(`[WhatsApp] Received message from ${fromNumber}`);
    
    let responseText = "";

    if (!mediaUrl || !latitude || !longitude) {
      responseText = "Welcome to CivicAgent! 🚨\\n\\nPlease reply with a *photo of the defect* and your *current location pin* to file a report.";
    } else {
      // 1. Download image from mediaUrl
      // 2. Run Gemini Vision to classify
      // 3. Run tiered routing with latitude/longitude
      // 4. Insert into Supabase
      
      console.log(`[WhatsApp] Processing image ${mediaUrl} at ${latitude}, ${longitude}`);

      // Placeholder tracking link
      const trackingId = `CA-${Math.floor(1000 + Math.random() * 9000)}`;
      const trackingLink = `https://namma.city/track/${trackingId}`;

      responseText = `✅ Report logged! We identified a defect at your location.\\n\\nWe have formally filed this with the local authority and the SLA clock is ticking.\\n\\nTrack live updates and verify the fix here: ${trackingLink}`;
    }

    // Return TwiML to reply to the WhatsApp user
    const twiml = `
      <Response>
        <Message>${responseText}</Message>
      </Response>
    `;

    return new NextResponse(twiml, {
      status: 200,
      headers: {
        "Content-Type": "text/xml",
      },
    });

  } catch (error) {
    console.error("[WhatsApp Webhook Error]", error);
    return new NextResponse("Internal Error", { status: 500 });
  }
}
