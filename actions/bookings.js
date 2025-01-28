"use server";

import { db } from "@/lib/prisma";
import { clerkClient } from "@clerk/nextjs/server";
import { google } from "googleapis";
import nodemailer from "nodemailer";

export async function createBooking(bookingData) {
  try {
    // Fetch the event and its creator
    const event = await db.event.findUnique({
      where: { id: bookingData.eventId },
      include: { user: true },
    });

    if (!event) {
      throw new Error("Event not found");
    }

    // Get the event creator's Google OAuth token from Clerk
    const { data } = await clerkClient.users.getUserOauthAccessToken(
      event.user.clerkUserId,
      "oauth_google"
    );

    const token = data[0]?.token;

    if (!token) {
      throw new Error("Event creator has not connected Google Calendar");
    }

    // Set up Google OAuth client
    const oauth2Client = new google.auth.OAuth2();
    oauth2Client.setCredentials({ access_token: token });

    const calendar = google.calendar({ version: "v3", auth: oauth2Client });

    // Create Google Meet link
    const meetResponse = await calendar.events.insert({
      calendarId: "primary",
      conferenceDataVersion: 1,
      requestBody: {
        summary: `${bookingData.name} - ${event.title}`,
        description: bookingData.additionalInfo,
        start: { dateTime: bookingData.startTime },
        end: { dateTime: bookingData.endTime },
        attendees: [{ email: bookingData.email }, { email: event.user.email }],
        conferenceData: {
          createRequest: { requestId: `${event.id}-${Date.now()}` },
        },
      },
    });

    const meetLink = meetResponse.data.hangoutLink;
    const googleEventId = meetResponse.data.id;

    // Create booking in the database
    const booking = await db.booking.create({
      data: {
        eventId: event.id,
        userId: event.userId,
        name: bookingData.name,
        email: bookingData.email,
        startTime: bookingData.startTime,
        endTime: bookingData.endTime,
        additionalInfo: bookingData.additionalInfo,
        meetLink,
        googleEventId,
      },
    });

    // Send confirmation email to the user
    const transporter = nodemailer.createTransport({
      service: "gmail", // Use your preferred email service
      auth: {
        user: process.env.EMAIL_USER, // Your email address
        pass: process.env.EMAIL_PASS, // Your email password or app password
      },
    });

    const mailOptions = {
      from: process.env.EMAIL_USER,
      to: bookingData.email,
      subject: `Booking Confirmation: ${event.title}`,
      html: `
        <p>Hi <strong>${bookingData.name}</strong>,</p>
        <p>I hope you are well.</p>
        <p>I just wanted to drop you a quick note to remind you that your maintanance for <strong>${event.title}</strong> has been scheduled on ${new Date(bookingData.startTime).toLocaleString()}</p>
        <p>Thank you for booking <strong>${event.title}</strong>.</p>
        <p>Here are your booking details:</p>
        <ul>
          <li><strong>Machine Name:</strong> ${event.title}</li>
          <li><strong>Start Time:</strong> ${new Date(bookingData.startTime).toLocaleString()}</li>
          <li><strong>End Time:</strong> ${new Date(bookingData.endTime).toLocaleString()}</li>
          <li><strong>Google Meet Link:</strong> <a href="${meetLink}" target="_blank">${meetLink}</a></li>
        </ul>
        <p>I would be really grateful if you could confirm that Schedule on the above date and time.</p>
        <p>If you have any questions, feel free to reach out to us.</p>
        <p>Best regards,</p>
        <p>Swasthya Coders</strong></p>
      `,
    };

    await transporter.sendMail(mailOptions);

    return { success: true, booking, meetLink };
  } catch (error) {
    console.error("Error creating booking:", error);
    return { success: false, error: error.message };
  }
}
