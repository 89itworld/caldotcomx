import { BookingStatus, Prisma } from "@prisma/client";
import type { NextApiRequest, NextApiResponse } from "next";

import { getSession } from "@lib/auth";
import prisma from "@lib/prisma";

const client_id = process.env.ZOOM_CLIENT_ID;
const client_secret = process.env.ZOOM_CLIENT_SECRET;

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (!["GET", "DELETE"].includes(req.method || "")) {
    return res.status(405).end();
  }

  // Check that user is authenticated
  const session = await getSession({ req });
  const userId = session?.user?.id;

  if (!userId) {
    res.status(401).json({ message: "You must be logged in to do this" });
    return;
  }

  if (req.method === "GET") {
    const credentials = await prisma.credential.findMany({
      where: {
        userId,
      },
      select: {
        type: true,
      },
    });

    res.status(200).json(credentials);
  }

  if (req.method == "DELETE") {
    const credentials = await prisma.credential.findFirst({
      where: {
        userId: session.user?.id,
        type: "zoom_video",
      },
      select: {
        type: true,
        key: true,
      },
    });

    const authHeader = "Basic" + Buffer.from(client_id + ":" + client_secret).toString("base64");
    const result = await fetch("https://zoom.us/oauth/revoke", {
      method: "POST",
      headers: {
        Authorization: authHeader,
        "Content-Type": "application/x-wwww-form-urlencoded",
      },
      body: "token=" + credentials?.key.access_token,
    });
    const responseBody = await result.json();
    console.log("revoke zoom_video", responseBody);

    const id = req.body.id;
    const data: Prisma.UserUpdateInput = {
      credentials: {
        delete: {
          id,
        },
      },
    };
    const integration = await prisma.credential.findUnique({
      where: {
        id,
      },
    });
    /* If the user deletes a zapier integration, we delete all his api keys as well. */
    if (integration?.appId === "zapier") {
      data.apiKeys = {
        deleteMany: {
          userId,
          appId: "zapier",
        },
      };
      /* We also delete all user's zapier wehbooks */
      data.webhooks = {
        deleteMany: {
          userId,
          appId: "zapier",
        },
      };
    }

    await prisma.user.update({
      where: {
        id: userId,
      },
      data,
    });

    if (req.body?.action === "cancel" || req.body?.action === "remove") {
      try {
        const bookingIdsWithPayments = await prisma.booking
          .findMany({
            where: {
              userId: session?.user?.id,
              paid: false,
              NOT: {
                payment: {
                  every: {
                    booking: null,
                  },
                },
              },
            },
            select: {
              id: true,
            },
          })
          .then((bookings) => bookings.map((booking) => booking.id));
        const deletePayments = prisma.payment.deleteMany({
          where: {
            bookingId: {
              in: bookingIdsWithPayments,
            },
            success: false,
          },
        });

        const updateBookings = prisma.booking.updateMany({
          where: {
            id: {
              in: bookingIdsWithPayments,
            },
          },
          data: {
            status: BookingStatus.CANCELLED,
            rejectionReason: "Payment provider got removed",
          },
        });

        const bookingReferences = await prisma.booking
          .findMany({
            where: {
              status: BookingStatus.ACCEPTED,
            },
            select: {
              id: true,
            },
          })
          .then((bookings) => bookings.map((booking) => booking.id));

        const deleteBookingReferences = prisma.bookingReference.deleteMany({
          where: {
            bookingId: {
              in: bookingReferences,
            },
          },
        });
        if (req.body?.action === "cancel") {
          await prisma.$transaction([deletePayments, updateBookings, deleteBookingReferences]);
        } else {
          const updateBookings = prisma.booking.updateMany({
            where: {
              id: {
                in: bookingIdsWithPayments,
              },
            },
            data: {
              paid: true,
            },
          });
          await prisma.$transaction([deletePayments, updateBookings]);
        }
      } catch (e) {
        console.error(e);
        res.status(500).json({ message: "Integration could not be deleted" });
      }
    }
    res.status(200).json({ message: "Integration deleted successfully" });
  }
}
