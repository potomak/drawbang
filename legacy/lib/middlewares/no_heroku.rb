# Redirect requests to heroku app domain to drawbang.com

class NoHeroku
  HEROKU_DOMAIN = /draw\.heroku\.com/i
  
  def initialize(app)
    @app = app
  end
  
  def call(env)
    if env['HTTP_HOST'] =~ HEROKU_DOMAIN
      [301, { 'Location' => Rack::Request.new(env).url.sub(HEROKU_DOMAIN, 'drawbang.com') }, ['Redirecting...']]
    else
      @app.call(env)
    end
  end
  
end