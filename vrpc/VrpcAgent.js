const { promisify } = require('util')
const mqtt = require('mqtt')
const crypto = require('crypto')
const VrpcAdapter = require('./VrpcAdapter')

class VrpcAgent {

  constructor ({
      domain,
      agent,
      username,
      password,
      token,
      broker = 'mqtts://vrpc.io:8883',
      log = console
    } = {}
  ) {
    this._username = username
    this._password = password
    this._token = token
    this._agent = agent
    this._domain = domain
    this._broker = broker
    this._log = log
    if (this._log.constructor && this._log.constructor.name === 'Console') {
      this._log.debug = () => {}
    }
    this._baseTopic = `${this._domain}/${this._agent}`
    VrpcAdapter.onCallback(this._handleVrpcCallback.bind(this))
  }

  async serve () {
    const md5 = crypto.createHash('md5').update(this._domain + this._agent).digest('hex').substr(0, 18)
    let username = this._username
    let password = this._password
    if (this._token) {
      username = '__token__'
      password = this._token
    }
    const options = {
      username,
      password,
      keepalive: 120,
      clean: true,
      connectTimeout: 10 * 1000,
      clientId: `vrpca${md5}`,
      rejectUnauthorized: false
    }
    this._log.info(`Domain : ${this._domain}`)
    this._log.info(`Agent  : ${this._agent}`)
    this._log.info(`Broker : ${this._broker}`)
    this._log.info('Connecting to MQTT server...')
    this._client = mqtt.connect(this._broker, options)
    this._client.on('connect', this._handleConnect.bind(this))
    this._client.on('reconnect', this._handleReconnect.bind(this))
    this._client.on('error', this._handleError.bind(this))
    this._client.on('message', this._handleMessage.bind(this))
    this._mqttPublish = promisify(this._client.publish.bind(this._client))
    this._mqttSubscribe = promisify(this._client.subscribe.bind(this._client))
    this._mqttUnsubscribe = promisify(this._client.unsubscribe.bind(this._client))
  }

  async _handleVrpcCallback (jsonString, jsonObject) {
    const { sender } = jsonObject
    try {
      this._log.debug(`Forwarding callback to: ${sender} with payload:`, jsonObject)
      await this._mqttPublish(sender, jsonString)
    } catch (err) {
      this._log.warn(
        err,
        `Problem publishing vrpc callback to ${sender} because of: ${err.message}`
      )
    }
  }

  async _handleConnect () {
    this._log.info('[OK]')
    try {
      const topics = this._generateTopics()
      await this._mqttSubscribe(topics)
    } catch (err) {
      this._log.error(
        err,
        `Problem during initial topic subscription: ${err.message}`
      )
    }
    // Publish class information
    const classes = VrpcAdapter.getClassesArray()
    classes.forEach(async klass => {
      const json = {
        class: klass,
        instances: VrpcAdapter.getInstancesArray(klass),
        memberFunctions: VrpcAdapter.getMemberFunctionsArray(klass),
        staticFunctions: VrpcAdapter.getStaticFunctionsArray(klass)
      }
      try {
        await this._mqttPublish(
          `${this._baseTopic}/${klass}/__static__/__info__`,
          JSON.stringify(json),
          { qos: 1, retain: true }
        )
      } catch (err) {
        this._log.error(
          err,
          `Problem during publishing class info: ${err.message}`
        )
      }
    })
  }

  _generateTopics () {
    const topics = []
    const classes = VrpcAdapter.getClassesArray()
    this._log.info(`Registering classes: ${classes}`)
    classes.forEach(klass => {
      const staticFunctions = VrpcAdapter.getStaticFunctionsArray(klass)
      staticFunctions.forEach(func => {
        topics.push(`${this._baseTopic}/${klass}/__static__/${func}`)
      })
    })
    return topics
  }

  async onDisconnect () {
    this._client.end()
    this._client.once('end', () => this._disconnectDone())
    await this.waitUntilState('disconnected')
  }

  async _handleMessage (topic, data) {
    try {
      let json = JSON.parse(data.toString())
      this._log.debug(`Message arrived with topic: ${topic} and payload:`, json)
      const tokens = topic.split('/')
      if (tokens.length !== 5) {
        this._log.warn(`Ignoring message with invalid topic: ${topic}`)
        return
      }
      const klass = tokens[2]
      const instance = tokens[3]
      const method = tokens[4]
      json.targetId = instance === '__static__' ? klass : instance
      json.method = method
      VrpcAdapter.call(json) // json is mutated and contains return value

      // Special case: object creation -> need to register subscriber
      if (method === '__create__' || method === '__createNamed__') {
        // TODO handle instantiation errors
        const instanceId = json.data.r
        this._subscribeToMethodsOfNewInstance(klass, instanceId)
      }
      await this._mqttPublish(json.sender, JSON.stringify(json), { qos: 1 })
    } catch (err) {
      this._log.error(err, `Problem while handling incoming message: ${err.message}`)
    }
  }

  _subscribeToMethodsOfNewInstance (klass, instance) {
    const memberFunctions = VrpcAdapter.getMemberFunctionsArray(klass)
    memberFunctions.forEach(async method => {
      const topic = `${this._baseTopic}/${klass}/${instance}/${method}`
      await this._mqttSubscribe(topic)
      this._log.debug(`Subscribed to new topic after instantiation: ${topic}`)
    })
  }

  _handleReconnect () {
    this._log.warn(`Reconnecting to ${this._broker}`)
  }

  _handleError (err) {
    this._log.error(err, `MQTT triggered error: ${err.message}`)
  }
}
module.exports = VrpcAgent
