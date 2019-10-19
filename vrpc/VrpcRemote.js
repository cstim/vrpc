/*
__/\\\________/\\\____/\\\\\\\\\______/\\\\\\\\\\\\\_________/\\\\\\\\\_
__\/\\\_______\/\\\__/\\\///////\\\___\/\\\/////////\\\____/\\\////////__
 __\//\\\______/\\\__\/\\\_____\/\\\___\/\\\_______\/\\\__/\\\/___________
  ___\//\\\____/\\\___\/\\\\\\\\\\\/____\/\\\\\\\\\\\\\/__/\\\_____________
   ____\//\\\__/\\\____\/\\\//////\\\____\/\\\/////////___\/\\\_____________
    _____\//\\\/\\\_____\/\\\____\//\\\___\/\\\____________\//\\\____________
     ______\//\\\\\______\/\\\_____\//\\\__\/\\\_____________\///\\\__________
      _______\//\\\_______\/\\\______\//\\\_\/\\\_______________\////\\\\\\\\\_
       ________\///________\///________\///__\///___________________\/////////__


Non-intrusively binds any JS code and provides access in form of asynchronous
remote procedural callbacks (RPC).
Author: Dr. Burkhard C. Heisen (https://github.com/bheisen/vrpc)


Licensed under the MIT License <http://opensource.org/licenses/MIT>.
Copyright (c) 2018 - 2019 Dr. Burkhard C. Heisen <burkhard.heisen@xsmail.com>.

Permission is hereby  granted, free of charge, to any  person obtaining a copy
of this software and associated  documentation files (the "Software"), to deal
in the Software  without restriction, including without  limitation the rights
to  use, copy,  modify, merge,  publish, distribute,  sublicense, and/or  sell
copies  of  the Software,  and  to  permit persons  to  whom  the Software  is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE  IS PROVIDED "AS  IS", WITHOUT WARRANTY  OF ANY KIND,  EXPRESS OR
IMPLIED,  INCLUDING BUT  NOT  LIMITED TO  THE  WARRANTIES OF  MERCHANTABILITY,
FITNESS FOR  A PARTICULAR PURPOSE AND  NONINFRINGEMENT. IN NO EVENT  SHALL THE
AUTHORS  OR COPYRIGHT  HOLDERS  BE  LIABLE FOR  ANY  CLAIM,  DAMAGES OR  OTHER
LIABILITY, WHETHER IN AN ACTION OF  CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE  OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
*/

const os = require('os')
const crypto = require('crypto')
const mqtt = require('mqtt')
const EventEmitter = require('events')
const { promisify } = require('util')

/**
 * Allows to work with code that is made available through one or more agents.
 *
 * This class provides the following events:
 * - agentInfo
 * - classInfo
 *
 * reflecting the content of the corresponding agentInfo and classInfo
 * messages.
 *
 */
class VrpcRemote extends EventEmitter {
  /**
   * Upon construction, a connection is tried to be established asynchronously.
   *
   * NOTE: Each instance creates its own physical connection to the broker.
   *
   * @param {string} token Access token as generated by: https://app.vrpc.io
   * @param {string} username MQTT username (if no token is used)
   * @param {string} password MQTT password (if no token is provided)
   * @param {string} domain Sets default domain.
   * @param {string} agent Sets default agent.
   * @param {string} broker Broker url in form: <scheme>://<host>:<port>
   * @param {number} timeout Maximum time in ms to wait for a RPC answer.
   */
  constructor ({
    token,
    username,
    password,
    agent = '*',
    domain = '*',
    broker = 'mqtts://vrpc.io:8883',
    timeout = 5 * 1000
  } = {}) {
    super()
    this._token = token
    this._username = username
    this._password = password
    this._agent = agent
    this._domain = domain
    this._broker = broker
    this._timeout = timeout
    this._instance = crypto.randomBytes(2).toString('hex')
    this._mqttClientId = this._createClientId(this._instance)
    this._vrpcClientId = `${domain}/${os.hostname()}/${this._instance}`
    this._domains = {}
    this._eventEmitter = new EventEmitter()
    this._invokeId = 0
    this._client = null
    this._init()
  }

  /**
   * Creates a new remote instance.
   *
   * @param {string} className Name of the class which should be instantiated.
   * @param {string} instance Optional. Name of the created instance.
   * @param {Array} args Array of constructor arguments (positional)
   * @param {string} agent Agent name. If not provided class default is used.
   * @param {string} domain Domain name. If not provided class default is used.
   * @return {Promise} Resolves to an object reflecting a proxy to the original
   * one handled by the agent. NOTE: You need to call all functions using
   * "await", asynchronous functions must be called using an "await await".
   */
  async create ({
    className,
    instance,
    args = [],
    agent = this._agent,
    domain = this._domain
  } = {}) {
    if (agent === '*') throw new Error('Agent must be specified')
    if (domain === '*') throw new Error('Domain must be specified')
    const data = instance ? { _1: instance } : {}
    const offset = instance ? 2 : 1
    args.forEach((value, index) => {
      data[`_${index + offset}`] = value
    })
    const json = {
      targetId: className,
      method: instance ? '__createNamed__' : '__create__',
      id: `${this._instance}-${this._invokeId++ % Number.MAX_SAFE_INTEGER}`,
      sender: `${domain}/${os.hostname()}/${this._instance}`,
      data
    }
    await this.connected()
    return this._getProxy(domain, agent, className, json)
  }

  /**
   * Get a remotely existing instance by name.
   *
   * @param {string} className Name of the instance's class
   * @param {string} instance The instance to be retrieved
   * @param {string} agent Agent name. If not provided class default is used.
   * @param {string} domain Domain name. If not provided class default is used.
   * @return {Promise} Resolves to an object reflecting the remotely existing instance.
   */
  async getInstance ({
    className,
    instance,
    agent = this._agent,
    domain = this._domain
  }) {
    const json = {
      targetId: className,
      method: '__getNamed__',
      id: `${this._instance}-${this._invokeId++ % Number.MAX_SAFE_INTEGER}`,
      sender: `${domain}/${os.hostname()}/${this._instance}`,
      data: { _1: instance }
    }
    await this.connected()
    return this._getProxy(domain, agent, className, json)
  }

  async delete ({
    className,
    instance,
    agent = this._agent,
    domain = this._domain
  }) {
    let targetId
    if (typeof (instance) === 'string') {
      targetId = instance
    } else if (typeof (instance) === 'object') {
      targetId = instance._targetId
    }
    const json = {
      targetId: className,
      method: '__delete__',
      id: `${this._instance}-${this._invokeId++ % Number.MAX_SAFE_INTEGER}`,
      sender: `${domain}/${os.hostname()}/${this._instance}`,
      data: { _1: targetId }
    }
    await this.connected()
    const topic = `${domain}/${agent}/${className}/__static__/__delete__`
    await this._mqttPublish(topic, JSON.stringify(json))
    return this._handleAgentAnswer(json.id)
  }

  /**
   * Calls a static function on a remote class
   *
   * @param {string} className Name of the static function's class
   * @param {string} functionName Name of the static function to be called
   * @param {Array} args Positional arguments of the static function call
   * @param {string} agent Agent name. If not provided class default is used.
   * @param {string} domain Domain name. If not provided class default is used.
   * @return {Promise} Resolves to the called function's return value
   */
  async callStatic ({
    className,
    functionName,
    args = [],
    agent = this._agent,
    domain = this._domain
  } = {}) {
    if (domain === '*') throw new Error('You must specify a domain')
    const json = {
      targetId: className,
      method: functionName,
      id: `${this._instance}-${this._invokeId++ % Number.MAX_SAFE_INTEGER}`,
      sender: this._vrpcClientId,
      data: this._packData(className, functionName, ...args)
    }
    await this.connected()
    const topic = `${domain}/${agent}/${className}/__static__/${functionName}`
    await this._mqttPublish(topic, JSON.stringify(json))
    return this._handleAgentAnswer(json.id)
  }

  /**
   * Retrieves all domains, agents, instances, classes, member and static
   * functions potentially available for remote control.
   *
   * @return {Promise} Resolves to an object with structure:
   * <domain>.agents.<agent>.classes.<className>.instances: []
   * <domain>.agents.<agent>.classes.<className>.memberFunctions: []
   * <domain>.agents.<agent>.classes.<className>.staticFunctions: []
   * <domain>.agents.<agent>.status: 'offline'|'online'
   * <domain>.agents.<agent>.hostname: <hostname>
   */
  async getAvailabilities () {
    await this.connected()
    return this._domains
  }

  /**
   * Retrieves all domains on which agents can be remote controlled.
   *
   * @return {Promise} Resolves to an array of domain names.
   */
  async getAvailableDomains () {
    await this.connected()
    return Object.keys(this._domains)
  }

  /**
   * Retrieves all available agents on specific domain.
   *
   * @param {string} domain Domain name. If not provided class default is used.
   * @return {Promise} Resolves to an array of agent names.
   */
  async getAvailableAgents (domain = this._domain) {
    if (domain === '*') throw new Error('Domain must be specified')
    await this.connected()
    return this._domains[domain]
      ? Object.keys(this._domains[domain].agents)
      : []
  }

  /**
   * Retrieves all available classes on specific agent and domain.
   *
   * @param {string} agent Agent name. If not provided class default is used.
   * @param {string} domain Domain name. If not provided class default is used.
   * @return {Promise} Resolves to an array of class names.
   */
  async getAvailableClasses (agent = this._agent, domain = this._domain) {
    if (agent === '*') throw new Error('Agent must be specified')
    if (domain === '*') throw new Error('Domain must be specified')
    await this.connected()
    return this._domains[domain]
      ? this._domains[domain].agents[agent]
        ? Object.keys(this._domains[domain].agents[agent].classes)
        : []
      : []
  }

  /**
   * Retrieves all (named) instances on specific class, agent and domain.
   *
   * @param {string} className Class name.
   * @param {string} agent Agent name. If not provided class default is used.
   * @param {string} domain Domain name. If not provided class default is used.
   * @return {Promise} Resolves to an array of instance names.
   */
  async getAvailableInstances (className, agent = this._agent, domain = this._domain) {
    if (agent === '*') throw new Error('Agent must be specified')
    if (domain === '*') throw new Error('Domain must be specified')
    await this.connected()
    return this._domains[domain]
      ? this._domains[domain].agents[agent]
        ? this._domains[domain].agents[agent].classes[className]
          ? this._domains[domain].agents[agent].classes[className].instances
          : []
        : []
      : []
  }

  /**
   * Retrieves all member functions of specific class, agent and domain.
   *
   * @param {string} className Class name.
   * @param {string} agent Agent name. If not provided class default is used.
   * @param {string} domain Domain name. If not provided class default is used.
   * @return {Promise} Resolves to an array of member function names.
   */
  async getAvailableMemberFunctions (className, agent = this._agent, domain = this._domain) {
    if (agent === '*') throw new Error('Agent must be specified')
    if (domain === '*') throw new Error('Domain must be specified')
    await this.connected()
    return this._domains[domain]
      ? this._domains[domain].agents[agent]
        ? this._domains[domain].agents[agent].classes[className]
          ? this._domains[domain].agents[agent].classes[className].memberFunctions.map(name => this._stripSignature(name))
          : []
        : []
      : []
  }

  /**
   * Retrieves all static functions of specific class, agent and domain.
   *
   * @param {string} className Class name.
   * @param {string} agent Agent name. If not provided class default is used.
   * @param {string} domain Domain name. If not provided class default is used.
   * @return {Promise} Resolves to an array of static function names.
   */
  async getAvailableStaticFunctions (className, agent = this._agent, domain = this._domain) {
    if (agent === '*') throw new Error('Agent must be specified')
    if (domain === '*') throw new Error('Domain must be specified')
    await this.connected()
    return this._domains[domain]
      ? this._domains[domain].agents[agent]
        ? this._domains[domain].agents[agent].classes[className]
          ? this._domains[domain].agents[agent].classes[className].staticFunctions.map(name => this._stripSignature(name))
          : []
        : []
      : []
  }

  /**
   * Reconnects to the broker by using a different token
   * @param {string} token Access token as generated by: https://app.vrpc.io
   * @param {string} agent Agent name. If not provided class default is used.
   * @param {string} domain Domain name. If not provided class default is used.
   * @return {PRomise} Resolve once re-connected.
   */
  async reconnectWithToken (
    token,
    { agent = this._agent, domain = this._domain } = {}
  ) {
    this._token = token
    this._agent = agent
    this._domain = domain
    this._client.end(() => this._init())
    return new Promise(resolve => {
      this._client.once('connect', resolve)
    })
  }

  /**
   * Ends the connection to the broker.
   *
   * @return {Promise} Resolves when ended.
   */
  async end () {
    await this._mqttPublish(
      `${this._vrpcClientId}/__info__`,
      JSON.stringify({ status: 'offline' })
    )
    return new Promise(resolve => this._client.end(resolve))
  }

  _createClientId (instance) {
    const clientInfo = os.arch() + JSON.stringify(os.cpus()) + os.homedir() +
    os.hostname() + JSON.stringify(os.networkInterfaces()) + os.platform() +
    os.release() + os.totalmem() + os.type()
    // console.log('ClientInfo:', clientInfo)
    const md5 = crypto.createHash('md5').update(clientInfo).digest('hex').substr(0, 13)
    return `vrpcp${instance}X${md5}` // 5 + 4 + 1 + 13 = 23 (max clientId)
  }

  _init () {
    let username = this._username
    let password = this._password
    if (this._token) {
      username = '__token__'
      password = this._token
    }
    const options = {
      username,
      password,
      clean: true,
      keepalive: 120,
      clientId: this._mqttClientId,
      rejectUnauthorized: false,
      will: {
        topic: `${this._vrpcClientId}/__info__`,
        payload: JSON.stringify({ status: 'offline' })
      }
    }
    this._client = mqtt.connect(this._broker, options)

    this._mqttPublish = promisify(this._client.publish.bind(this._client))
    this._mqttSubscribe = promisify(this._client.subscribe.bind(this._client))
    this._mqttUnsubscribe = promisify(this._client.unsubscribe.bind(this._client))

    this._client.on('connect', () => {
      // This will give us an overview of all remotely available classes
      const domain = this._domain === '*' ? '+' : this._domain
      const agent = this._agent === '*' ? '+' : this._agent
      this._client.subscribe(`${domain}/${agent}/+/__static__/__info__`)
      // Listen for remote function return values
      this._client.subscribe(this._vrpcClientId)
    })

    this._client.on('message', (topic, message) => {
      if (message.length === 0) return
      const tokens = topic.split('/')
      const [domain, agent, klass, instance, func] = tokens
      if (func === '__info__' && instance === '__static__') {
        // AgentInfo message
        if (klass === '__agent__') {
          const { status, hostname } = JSON.parse(message.toString())
          this._createIfNotExist(domain, agent)
          this._domains[domain].agents[agent].status = status
          this._domains[domain].agents[agent].hostname = hostname
          this.emit('agent', { domain, agent, status, hostname })
        } else { // ClassInfo message
          // Json properties: { className, instances, memberFunctions, staticFunctions }
          const json = JSON.parse(message.toString())
          this._createIfNotExist(domain, agent)
          this._domains[domain].agents[agent].classes[klass] = json
          const {
            className,
            instances,
            memberFunctions,
            staticFunctions
          } = json
          this.emit(
            'class',
            {
              domain,
              agent,
              className,
              instances,
              memberFunctions,
              staticFunctions
            }
          )
        }
      } else { // RPC message
        const { id, data } = JSON.parse(message.toString())
        this._eventEmitter.emit(id, data)
      }
    })
  }

  _createIfNotExist (domain, agent) {
    if (!this._domains[domain]) {
      this._domains[domain] = { agents: {} }
    }
    if (!this._domains[domain].agents[agent]) {
      this._domains[domain].agents[agent] = { classes: {} }
    }
  }

  async connected () {
    return new Promise((resolve) => {
      if (this._client.connected) {
        resolve()
      } else {
        this._client.once('connect', () => {
          // Give agentInfo and classInfo messages a chance to arrive before
          // anyone messes around with us
          setTimeout(resolve, 200)
        })
      }
    })
  }

  async _getProxy (domain, agent, className, json) {
    const { method } = json
    const topic = `${domain}/${agent}/${className}/__static__/${method}`
    await this._mqttPublish(topic, JSON.stringify(json))
    return new Promise((resolve, reject) => {
      const msg = `Proxy creation timed out (> ${this._timeout} ms)`
      const id = setTimeout(
        () => {
          this._eventEmitter.removeAllListeners(json.id)
          reject(new Error(msg))
        },
        this._timeout
      )
      this._eventEmitter.once(json.id, data => {
        clearTimeout(id)
        if (data.e) {
          reject(new Error(data.e))
        } else {
          const proxy = this._createProxy(domain, agent, className, data)
          resolve(proxy)
        }
      })
    })
  }

  async _createProxy (domain, agent, className, data) {
    const instance = data.r
    const targetTopic = `${domain}/${agent}/${className}/${instance}`
    const proxyId = crypto.randomBytes(2).toString('hex')
    const proxy = {
      _targetId: instance,
      _proxyId: proxyId
    }
    let functions = this._domains[domain].agents[agent].classes[className].memberFunctions
    // Strip off argument signature
    functions = functions.map(name => {
      const pos = name.indexOf('-')
      if (pos > 0) return name.substring(0, pos)
      return name
    })
    // Remove overloads
    const uniqueFuncs = new Set(functions)
    // Build proxy
    uniqueFuncs.forEach(name => {
      proxy[name] = async (...args) => {
        try {
          const json = {
            targetId: instance,
            method: name,
            id: `${this._instance}-${this._invokeId++ % Number.MAX_SAFE_INTEGER}`,
            sender: this._vrpcClientId,
            data: this._packData(proxyId, name, ...args)
          }
          await this._mqttPublish(`${targetTopic}/${name}`, JSON.stringify(json))
          return this._handleAgentAnswer(json.id)
        } catch (err) {
          if (err.message !== 'Repeated event registration') {
            throw new Error(`VRPC encountered error while trying a remote function call: ${err.message}`)
          }
        }
      }
    })
    return proxy
  }

  async _handleAgentAnswer (id) {
    return new Promise((resolve, reject) => {
      const msg = `Function call timed out (> ${this._timeout} ms)`
      const timer = setTimeout(
        () => {
          this._eventEmitter.removeAllListeners(id)
          reject(new Error(msg))
        },
        this._timeout
      )
      this._eventEmitter.once(id, data => {
        clearTimeout(timer)
        if (data.e) {
          reject(new Error(data.e))
        } else {
          const ret = data.r
          // Handle functions returning a promise
          if (typeof ret === 'string' && ret.substr(0, 5) === '__p__') {
            const promise = new Promise((resolve, reject) => {
              this._eventEmitter.once(ret, promiseData => {
                if (promiseData.e) reject(new Error(promiseData.e))
                else resolve(promiseData.r)
              })
            })
            resolve(promise)
          } else {
            resolve(ret)
          }
        }
      })
    })
  }

  _packData (proxyId, functionName, ...args) {
    const data = {}
    args.forEach((value, index) => {
      // Check whether provided argument is a function
      if (this._isFunction(value)) {
        // Check special case of an event emitter registration
        // We test three conditions:
        // 1) functionName must be "on"
        // 2) callback is second argument
        // 3) first argument was string
        if (functionName === 'on' &&
          index === 1 &&
          typeof args[0] === 'string'
        ) {
          const id = `__f__${proxyId}-${functionName}-${index}-${args[0]}`
          data[`_${index + 1}`] = id
          this._eventEmitter.on(id, data => {
            const args = Object.keys(data).sort()
              .filter(value => value[0] === '_')
              .map(key => data[key])
            value.apply(null, args)
          })
        // Regular function callback
        } else {
          const id = `__f__${proxyId}-${functionName}-${index}-${this._invokeId++ % Number.MAX_SAFE_INTEGER}`
          data[`_${index + 1}`] = id
          this._eventEmitter.once(id, data => {
            const args = Object.keys(data).sort()
              .filter(value => value[0] === '_')
              .map(key => data[key])
            value.apply(null, args) // This is the actual function call
          })
        }
      } else if (this._isEmitter(value)) {
        const { emitter, event } = value
        const id = `__f__${proxyId}-${functionName}-${index}-${event}`
        data[`_${index + 1}`] = id
        this._eventEmitter.on(id, data => {
          const args = Object.keys(data).sort()
            .filter(value => value[0] === '_')
            .map(key => data[key])
          emitter.emit(event, ...args)
        })
      } else {
        data[`_${index + 1}`] = value
      }
    })
    return data
  }

  _stripSignature (method) {
    const pos = method.indexOf('-')
    if (pos > 0) return method.substring(0, pos)
    return method
  }

  _isFunction (variable) {
    const getType = {}
    const type = getType.toString.call(variable)
    return variable &&
      (type === '[object Function]' || type === '[object AsyncFunction]')
  }

  _isEmitter (variable) {
    return (
      typeof variable === 'object' &&
      variable.hasOwnProperty('emitter') &&
      variable.hasOwnProperty('event') &&
      typeof variable.emitter === 'object' &&
      typeof variable.emitter.emit === 'function'
    )
  }
}

module.exports = VrpcRemote
