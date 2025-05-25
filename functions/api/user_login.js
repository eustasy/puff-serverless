export async function onRequestPost(context) {
  try {
    // Get the request body as form data
    const formData = await context.request.formData();
    const email = formData.get('email');
    const password = formData.get('pw');

    // Placeholder authentication logic
    if (password === 'password') {
      return new Response('<p>Login successful! (Placeholder)</p>', {
        headers: { 'Content-Type': 'text/html' },
      });
    } else {
      return new Response('<p>Login failed. Please check your credentials. (Placeholder)</p>', {
        headers: { 'Content-Type': 'text/html' },
      });
    }
  } catch (error) {
    console.error('Login error:', error);
    return new Response('<p>An unexpected error occurred.</p>', {
      status: 500,
      headers: { 'Content-Type': 'text/html' },
    });
  }
}
