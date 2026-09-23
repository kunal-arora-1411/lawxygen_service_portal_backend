import transporter from "../config/mailer.js";

export const sendWelcomeEmail = async (email, name) => {
  const mailOptions = {
    from: process.env.SMTP_FROM,

    to: email,

    subject: "Welcome to Lawxygen! 🎉",

    html: `
      <div style="
        font-family: Arial, sans-serif;
        max-width: 600px;
        margin: 0 auto;
        padding: 30px;
        color: #222;
      ">

        <h1>Welcome to Lawxygen! 🎉</h1>

        <p>Hi ${name},</p>

        <p>
          Welcome to Lawxygen!
          Your account has been successfully created.
        </p>

        <p>
          You can now explore our legal services
          and manage your requirements through your account.
        </p>

        <br />

        <p>
          Regards,<br />
          <strong>Team Lawxygen</strong>
        </p>

      </div>
    `,
  };

  const info = await transporter.sendMail(mailOptions);

  return info;
};

export const sendPasswordResetOTP = async (email, otp) => {
  await transporter.sendMail({
    from: process.env.SMTP_FROM,

    to: email,

    subject: "Lawxygen Password Reset OTP",

    html: `
      <div style="font-family: Arial, sans-serif;">

        <h2>Reset Your Lawxygen Password</h2>

        <p>
          We received a request to reset your password.
        </p>

        <p>Your OTP is:</p>

        <h1 style="letter-spacing: 8px;">
          ${otp}
        </h1>

        <p>
          This OTP is valid for 10 minutes.
        </p>

        <p>
          If you didn't request a password reset,
          you can safely ignore this email.
        </p>

        <br />

        <p>
          Regards,<br />
          <strong>Team Lawxygen</strong>
        </p>

      </div>
    `,
  });
};