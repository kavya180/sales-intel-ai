import { NextResponse } from 'next/server';

const isProduction = process.env.NODE_ENV === 'production';

export async function POST() {
  const response = NextResponse.json(
    {
      success: true,
      message: 'Logged out successfully.',
    },
    {
      status: 200,
      headers: {
        'Cache-Control': 'no-store',
      },
    }
  );

  /*
   * Explicitly expire the authentication cookie using the same security
   * attributes used when it is created. This is more robust than relying
   * only on cookies.delete() when deployments/proxies differ.
   */
  response.cookies.set({
    name: 'auth_session_token',
    value: '',
    httpOnly: true,
    secure: isProduction,
    sameSite: 'lax',
    path: '/',
    expires: new Date(0),
    maxAge: 0,
  });

  return response;
}
