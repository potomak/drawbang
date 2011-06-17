class User
  def initialize(user)
    @user = user
  end
  
  def save
    REDIS.set @user.delete(:key), @user.to_json
  end
  
  def self.find(key)
    value = REDIS.get(key)
    JSON.parse(value) unless value.nil?
  end
end