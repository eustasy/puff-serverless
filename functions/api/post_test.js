import { password_requirements } from './../../src/passwords.js';

const getMethods = (obj) => {
  let properties = new Set()
  let currentObj = obj
  do {
    Object.getOwnPropertyNames(currentObj).map(item => properties.add(item))
  } while ((currentObj = Object.getPrototypeOf(currentObj)))
  return [...properties.keys()].filter(item => typeof obj[item] === 'function')
}

export async function onRequest(context) {
  const formdata = getMethods(context.request)
  //let pw = formdata.get('pw')
  //let response_html = await password_requirements(pw)
  return Response.json(formdata)
}
