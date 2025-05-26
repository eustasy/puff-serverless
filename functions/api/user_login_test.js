import { user_register, user_login } from "./../../src/users.js"

export async function onRequest(context) {
  const testName = "Login Test User"
  const testEmail = "logintest@example.com"
  const testPassword = "Password123!@#"

  const testResults = []

  // Test 1: User Registration
  try {
    const registrationResult = await user_register(
      context,
      testName,
      testEmail,
      testPassword
    )
    // Assuming user_register returns an object like { success: true, ... } or throws error
    // and that D1Result.success is true on successful insert
    if (registrationResult && registrationResult.success === true) {
      testResults.push({ test: "User Registration", status: "success" })
    } else {
      // This case might occur if the user already exists and user_register handles it by returning non-true success
      testResults.push({
        test: "User Registration",
        status: "failure",
        error:
          "Registration did not report success, user might already exist or another issue.",
        details: registrationResult,
      })
    }
  } catch (error) {
    testResults.push({
      test: "User Registration",
      status: "failure",
      error: error.message,
    })
  }

  // Test 2: Login with Correct Credentials
  try {
    const loginResult = await user_login(context, testEmail, testPassword)
    const expected = "Login successful! Session created."
    if (loginResult === expected) {
      testResults.push({
        test: "Login Correct Credentials",
        status: "success",
        expected,
        actual: loginResult,
      })
    } else {
      testResults.push({
        test: "Login Correct Credentials",
        status: "failure",
        expected,
        actual: loginResult,
      })
    }
  } catch (error) {
    testResults.push({
      test: "Login Correct Credentials",
      status: "failure",
      error: error.message,
    })
  }

  // Test 3: Login with Incorrect Password
  try {
    const loginResultIncorrect = await user_login(
      context,
      testEmail,
      "WrongPassword123!@#"
    )
    const expected = "Invalid email or password."
    if (loginResultIncorrect === expected) {
      testResults.push({
        test: "Login Incorrect Password",
        status: "success",
        expected,
        actual: loginResultIncorrect,
      })
    } else {
      testResults.push({
        test: "Login Incorrect Password",
        status: "failure",
        expected,
        actual: loginResultIncorrect,
      })
    }
  } catch (error) {
    testResults.push({
      test: "Login Incorrect Password",
      status: "failure",
      error: error.message,
    })
  }

  // Test 4: Login with Non-existent User
  try {
    const loginResultNonExistent = await user_login(
      context,
      "nouser@example.com",
      "anypassword"
    )
    const expected = "Invalid email or password."
    if (loginResultNonExistent === expected) {
      testResults.push({
        test: "Login Non-existent User",
        status: "success",
        expected,
        actual: loginResultNonExistent,
      })
    } else {
      testResults.push({
        test: "Login Non-existent User",
        status: "failure",
        expected,
        actual: loginResultNonExistent,
      })
    }
  } catch (error) {
    testResults.push({
      test: "Login Non-existent User",
      status: "failure",
      error: error.message,
    })
  }

  return new Response(JSON.stringify(testResults, null, 2), {
    headers: { "Content-Type": "application/json" },
  })
}
